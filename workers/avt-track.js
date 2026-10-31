// AVT GPS — Cloudflare Worker "avt-track" on track.vmavt.com
// Receives positions from the AVT kit's GPS page (OsmAnd / Traccar format),
// keeps them in D1, and shows each car on a map to its owner and to VM.
//
// Bindings (Worker > Settings):
//   D1 database  : DB            (any name, e.g. avt-track)
//   Secret       : OWNER_SECRET  (any long random text — makes the owner links)
//   Secret       : ADMIN_KEY     (your own password for /admin)
//   Secret       : TG_TOKEN      (same bot token as avt-fleet, optional)
//   Variable     : TG_CHAT       (your Telegram chat id, optional)
// Cron trigger   : 0 3 * * *     (daily clean-up of positions older than KEEP_DAYS)

const KEEP_DAYS = 30;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      await ensureTables(env);
      const p = url.pathname;
      if (p === "/ping") return text("ok avt-track");
      if (p === "/" && (url.searchParams.has("lat") || req.method === "POST")) return report(req, url, env);
      if (p === "/admin") return admin(url, env);
      let m = p.match(/^\/api\/c\/([A-Za-z0-9_.-]{1,64})$/);
      if (m) {
        const r = await carApi(m[1], url, env);
        r.headers.set("access-control-allow-origin", "https://cam.vmavt.com");
        return r;
      }
      m = p.match(/^\/c\/([A-Za-z0-9_.-]{1,64})$/);
      if (m) return carPage(m[1], url, env);
      return text("AVT GPS", 200);
    } catch (e) {
      return text("error: " + (e && e.message), 500);
    }
  },
  async scheduled(_ev, env) {
    await ensureTables(env);
    const cut = Math.floor(Date.now() / 1000) - KEEP_DAYS * 86400;
    await env.DB.prepare("DELETE FROM fixes WHERE ts < ?").bind(cut).run();
  },
};

let tablesReady = false;
async function ensureTables(env) {
  if (tablesReady) return;
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS fixes (id TEXT, ts INTEGER, lat REAL, lon REAL, speed REAL, bearing REAL, acc REAL, batt INTEGER)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS fixes_id_ts ON fixes (id, ts)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS cars (id TEXT PRIMARY KEY, name TEXT, first_seen INTEGER, last_ts INTEGER, lat REAL, lon REAL, speed REAL, batt INTEGER, key TEXT)"),
  ]);
  tablesReady = true;
}

// ---------- receiving positions from cars ----------
async function report(req, url, env) {
  const q = new URLSearchParams(url.search);
  if (req.method === "POST") {
    const ct = req.headers.get("content-type") || "";
    if (ct.includes("application/x-www-form-urlencoded")) {
      for (const [k, v] of new URLSearchParams(await req.text())) q.set(k, v);
    }
  }
  const id = (q.get("id") || q.get("deviceid") || "").trim();
  const lat = parseFloat(q.get("lat")), lon = parseFloat(q.get("lon"));
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(id) || !isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return text("bad report", 400);
  }
  const now = Math.floor(Date.now() / 1000);
  let ts = parseInt(q.get("timestamp") || "0", 10);
  if (!ts || ts > now + 600 || ts < now - 7 * 86400) ts = now;
  const knots = parseFloat(q.get("speed") || "0");
  const kmh = isFinite(knots) ? Math.round(knots * 1.852 * 10) / 10 : 0;
  const bearing = num(q.get("bearing")), acc = num(q.get("accuracy"));
  const batt = q.has("batt") ? parseInt(q.get("batt"), 10) : null;

  // Each car sends its own private key (?key=… in its server address). The first report claims the
  // car ID; after that only reports with the same key are accepted, and the same key lets the
  // owner's phone see the car.
  const key = (q.get("key") || "").trim();
  if (key && !/^[A-Za-z0-9_-]{16,64}$/.test(key)) return text("bad key", 400);
  const known = await env.DB.prepare("SELECT id, key FROM cars WHERE id = ?").bind(id).first();
  if (known && known.key && known.key !== key) return text("wrong key", 403);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO fixes (id, ts, lat, lon, speed, bearing, acc, batt) VALUES (?,?,?,?,?,?,?,?)")
      .bind(id, ts, lat, lon, kmh, bearing, acc, batt),
    env.DB.prepare(
      "INSERT INTO cars (id, first_seen, last_ts, lat, lon, speed, batt, key) VALUES (?,?,?,?,?,?,?,?) " +
      "ON CONFLICT(id) DO UPDATE SET last_ts = excluded.last_ts, lat = excluded.lat, lon = excluded.lon, speed = excluded.speed, batt = excluded.batt, " +
      "key = COALESCE(cars.key, excluded.key) WHERE excluded.last_ts >= cars.last_ts"
    ).bind(id, now, ts, lat, lon, kmh, batt, key || null),
  ]);
  if (!known) await telegramNewCar(env, url, id, key);
  return text("OK");
}

async function telegramNewCar(env, url, id, key) {
  if (!env.TG_TOKEN || !env.TG_CHAT) return;
  const link = `${url.origin}/c/${id}?k=${key || (await ownerKey(env, id))}`;
  const msg = `📍 New car on AVT GPS\nID: ${id}\n\nOwner link (send this to the car owner):\n${link}`;
  try {
    await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: env.TG_CHAT, text: msg, disable_web_page_preview: true }),
    });
  } catch (_) {}
}

// ---------- owner access ----------
async function ownerKey(env, id) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.OWNER_SECRET || "set-OWNER_SECRET"),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("car:" + id)));
  return btoa(String.fromCharCode(...sig)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "").slice(0, 22);
}
async function allowed(env, id, url) {
  const k = url.searchParams.get("k") || "";
  if (!k) return false;
  if (env.ADMIN_KEY && k === env.ADMIN_KEY) return true;
  const car = await env.DB.prepare("SELECT key FROM cars WHERE id = ?").bind(id).first();
  if (car && car.key) return k === car.key;
  return k === (await ownerKey(env, id));
}

async function carApi(id, url, env) {
  if (!(await allowed(env, id, url))) return json({ error: "not allowed" }, 403);
  const hours = Math.min(Math.max(parseInt(url.searchParams.get("hours") || "24", 10) || 24, 1), 24 * KEEP_DAYS);
  const since = Math.floor(Date.now() / 1000) - hours * 3600;
  const car = await env.DB.prepare("SELECT * FROM cars WHERE id = ?").bind(id).first();
  if (car) delete car.key;
  const { results } = await env.DB.prepare(
    "SELECT ts, lat, lon, speed FROM fixes WHERE id = ? AND ts >= ? ORDER BY ts LIMIT 20000"
  ).bind(id, since).all();
  return json({ car, path: results || [] });
}

async function carPage(id, url, env) {
  if (!(await allowed(env, id, url))) return html(simplePage("Link not valid", "Ask the person who set up AVT on your car for your car's link."), 403);
  return html(mapPage({ title: "My car", id, k: url.searchParams.get("k") }));
}

// ---------- VM admin ----------
async function admin(url, env) {
  const k = url.searchParams.get("k") || "";
  if (!env.ADMIN_KEY || k !== env.ADMIN_KEY) return html(simplePage("AVT GPS", "Admin key needed."), 403);
  if (url.searchParams.has("json")) {
    const { results } = await env.DB.prepare("SELECT * FROM cars ORDER BY last_ts DESC").all();
    const cars = [];
    for (const c of results || []) { const { key, ...rest } = c; cars.push({ ...rest, link: `${url.origin}/c/${c.id}?k=${key || (await ownerKey(env, c.id))}` }); }
    return json({ cars });
  }
  return html(adminPage(k));
}

// ---------- helpers ----------
function num(v) { const n = parseFloat(v); return isFinite(n) ? n : null; }
function text(s, status = 200) { return new Response(s, { status, headers: { "content-type": "text/plain; charset=utf-8" } }); }
function json(o, status = 200) { return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } }); }
function html(s, status = 200) { return new Response(s, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }); }
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

const HEAD = `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<style>
:root{--bg:#f4f5f7;--card:#fff;--ink:#111;--ink2:#5d6168;--line:#000;--accent:#0aa37f}
@media (prefers-color-scheme:dark){:root{--bg:#000;--card:#111;--ink:#f2f2f2;--ink2:#9aa0a8;--line:#3a3d42;--accent:#17c495}}
*{box-sizing:border-box}html,body{margin:0;height:100%;background:var(--bg);color:var(--ink);font:15px/1.4 -apple-system,Roboto,system-ui,sans-serif}
#map{position:absolute;inset:0}
.panel{position:absolute;left:12px;right:12px;bottom:max(12px,env(safe-area-inset-bottom));z-index:500;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:14px 16px;max-width:460px}
.panel h1{font-size:17px;margin:0 0 2px;font-weight:600}.sub{color:var(--ink2);font-size:13px}
.row{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}
.chip{border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:16px;height:34px;padding:0 13px;font:inherit;font-size:14px}
.chip.on{background:var(--accent);border-color:var(--accent);color:#fff}
.stat b{font-size:20px;font-variant-numeric:tabular-nums}
.note{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center}
.carDot{width:18px;height:18px;border-radius:50%;background:var(--accent);border:3px solid #fff;box-shadow:0 0 0 2px rgba(0,0,0,.25)}
</style>`;

function simplePage(title, msg) {
  return `<!doctype html><html><head>${HEAD}<title>${esc(title)}</title></head><body><div class="note"><div><h2>${esc(title)}</h2><p class="sub">${esc(msg)}</p></div></div></body></html>`;
}

function mapPage({ title, id, k }) {
  return `<!doctype html><html><head>${HEAD}<title>AVT GPS</title></head><body>
<div id="map"></div>
<div class="panel">
  <h1>${esc(title)}</h1>
  <div class="sub" id="when">Loading…</div>
  <div class="row stat" id="stat"></div>
  <div class="row">
    <button class="chip on" data-h="24">24 hours</button><button class="chip" data-h="168">7 days</button><button class="chip" data-h="720">30 days</button>
    <a class="chip" id="nav" style="display:none;align-items:center;text-decoration:none" target="_blank">Directions</a>
  </div>
</div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
var ID=${JSON.stringify(id)},K=${JSON.stringify(k || "")},hours=24,first=true;
var map=L.map('map',{zoomControl:false}).setView([11.56,104.92],12);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap'}).addTo(map);
var line=L.polyline([],{color:'#0aa37f',weight:4,opacity:.8}).addTo(map);
var dot=L.marker([0,0],{icon:L.divIcon({className:'',html:'<div class="carDot"></div>',iconSize:[18,18],iconAnchor:[9,9]})});
function ago(ts){var s=Math.max(0,Date.now()/1000-ts);if(s<90)return'just now';if(s<3600)return Math.round(s/60)+' min ago';if(s<86400)return Math.round(s/3600)+' h ago';return Math.round(s/86400)+' days ago'}
function load(){fetch('/api/c/'+encodeURIComponent(ID)+'?k='+encodeURIComponent(K)+'&hours='+hours,{cache:'no-store'}).then(r=>r.json()).then(function(d){
  var c=d.car;if(!c){document.getElementById('when').textContent='No position yet — turn on Tracking in the AVT kit\\'s GPS page.';return}
  var ll=[c.lat,c.lon];dot.setLatLng(ll).addTo(map);
  line.setLatLngs((d.path||[]).map(function(p){return[p.lat,p.lon]}));
  document.getElementById('when').textContent='Last seen '+ago(c.last_ts)+' · '+new Date(c.last_ts*1000).toLocaleString();
  document.getElementById('stat').innerHTML='<div><b>'+Math.round(c.speed||0)+'</b> km/h</div>'+(c.batt!=null&&c.batt>=0?'<div style="margin-left:18px"><b>'+c.batt+'</b> % battery</div>':'');
  var nav=document.getElementById('nav');nav.href='https://www.google.com/maps/dir/?api=1&destination='+c.lat+','+c.lon;nav.style.display='inline-flex';
  if(first){map.setView(ll,15);first=false}
})}
document.querySelectorAll('[data-h]').forEach(function(b){b.onclick=function(){hours=+b.dataset.h;document.querySelectorAll('[data-h]').forEach(function(x){x.classList.toggle('on',x===b)});if(line.getLatLngs().length)map.fitBounds(line.getBounds(),{padding:[30,30]});load()}});
load();setInterval(load,15000);
</script></body></html>`;
}

function adminPage(k) {
  return `<!doctype html><html><head>${HEAD}<title>AVT GPS — all cars</title>
<style>.list{position:absolute;top:12px;right:12px;bottom:12px;width:min(380px,calc(100% - 24px));z-index:500;background:var(--card);border:1px solid var(--line);border-radius:16px;overflow:auto;padding:12px}
.car{padding:10px 6px;border-bottom:1px solid rgba(128,128,128,.25);cursor:pointer}.car b{display:block}.car a{font-size:13px;color:var(--accent)}
@media (max-width:700px){.list{top:auto;height:45%}}</style></head><body>
<div id="map"></div><div class="list" id="list"><h1 style="font-size:17px;margin:4px 6px 8px">AVT GPS · all cars</h1></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
var K=${JSON.stringify(k)};var map=L.map('map').setView([11.56,104.92],11);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap'}).addTo(map);
var marks={},fitted=false;
function ago(ts){var s=Math.max(0,Date.now()/1000-ts);if(s<90)return'just now';if(s<3600)return Math.round(s/60)+' min ago';if(s<86400)return Math.round(s/3600)+' h ago';return Math.round(s/86400)+' days ago'}
function load(){fetch('/admin?json=1&k='+encodeURIComponent(K),{cache:'no-store'}).then(r=>r.json()).then(function(d){
  var list=document.getElementById('list');list.querySelectorAll('.car').forEach(function(e){e.remove()});var pts=[];
  (d.cars||[]).forEach(function(c){var ll=[c.lat,c.lon];pts.push(ll);
    if(!marks[c.id])marks[c.id]=L.marker(ll).addTo(map).bindPopup(c.id);else marks[c.id].setLatLng(ll);
    var el=document.createElement('div');el.className='car';
    el.innerHTML='<b>'+c.id+'</b><span class="sub">'+ago(c.last_ts)+' · '+Math.round(c.speed||0)+' km/h</span><br><a target="_blank" href="'+c.link+'">Owner link</a>';
    el.onclick=function(e){if(e.target.tagName!=='A')map.setView(ll,15)};list.appendChild(el)});
  if(!fitted&&pts.length){map.fitBounds(pts,{padding:[40,40],maxZoom:15});fitted=true}
})}
load();setInterval(load,20000);
</script></body></html>`;
}
