# AVT lyrics library

Every AVT car (AVT kit 2.5.6 and up) copies the `.lrc` files in this folder and
uses them **before** any online lyrics source. Use it for songs the internet
doesn't have — mostly Khmer songs.

## Add a song

1. Make a time-synced `.lrc` file (lines like `[00:12.34]lyric line`).
2. Name it after the song, exactly as the car shows it:
   - `Title.lrc`, or
   - `Artist - Title.lrc` (best — avoids mixing up songs with the same name), or
   - `Title - Artist.lrc`
3. Upload it into this `lyrics` folder (GitHub website → Add file → Upload files).

That's all. `index.txt` updates by itself a minute later, and cars pick up new
or changed files within about 6 hours (or next time the kit looks for lyrics
after that).

To fix a song, upload the corrected file with the same name. To remove one,
delete it here; cars that already have it keep using it.
