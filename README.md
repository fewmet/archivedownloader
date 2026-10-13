# archivedownloader

**This is a port of [The Ultimate Uzi Archive](https://uziarchive.top) (uziarchive.top), the Lil Uzi Vert archive run by @flexbymistake.** The idea, the layout and the features all come from their site. archivedownloader is the same thing remade to read the Yeat tracker instead. If you like it, go use the original.

It reads the public Yeat tracker sheet and shows every song by era, with search, filters, a player, and tagged downloads.

## Credits

- **Original site, design and feature set:** [The Ultimate Uzi Archive](https://uziarchive.top). Their credits page lists:
    - **zdb** (@zdb_): Song & Snippet Tracker
    - **Bully** (@localbully88): Studio Session Archive, Lives Archive, Snippets Archive
    - **Flex By Mistake** (@flexbymistake): Site Creator, Performances Archive, Snippets Archive, Lives Archive
    - **Overlord** (@wrldoverlord): Song & Snippet Tracker, File Archive
- **Yeat song data:** the [Yeat Trackër](https://docs.google.com/spreadsheets/d/1FUzAZyTCgFTVxQ--qbCAS2bUk4dsAw6ASxwjURPHbyI/edit), edited by **raglord**, **red.**, **shock**, **Snarke** and **zamfir**. Every song, era, date, note and cover on the site comes from it.
- **Files:** hosted on pillows.su and imgur.gg. Nothing is hosted here.

None of them make or run this port, so problems with it shouldn't go to them. The site's own Credits page (`/credits`) shows all of this too.

## Run it on your PC

Double-click `Start archivedownloader (Windows).bat` (or `Start archivedownloader (Mac).command` on a Mac). The site opens in your browser. Close the black window to stop it.

There's nothing to install. If the computer doesn't have Node.js 18+, the start file downloads a private copy into a `runtime` folder the first time. `HOW TO RUN.txt` has the plain-English version for other people.

From a terminal you can also run `node server.js`. If port 3000 is taken it moves to 3001, 3002 and so on.

## Run it publicly

Set `PUBLIC=1` and a fixed `PORT`, and put a reverse proxy (Caddy) in front of it. In public mode it only listens on 127.0.0.1, stays on the port you gave it, never tries to open a browser, and limits how many downloads run at once so a small server doesn't fall over. The step-by-step guide for the Oracle server is separate.

## How it works

- `server.js` downloads these tabs of the tracker sheet as CSV every 15 minutes: Unreleased, Released, Art, Snippets/Partials, Stems, Instagram Lives, Music Videos, Live Performances, Samples, Misc.
- Unreleased + Released become the Songs page. The other tabs each get their own page in the top bar.
- Songs on pillows.su play straight from pillows in the visitor's browser, so the server doesn't pay for playback bandwidth. imgur.gg files (mostly Lives and snippets) go through `/imgur/:id`, which looks up the real file once and redirects to it.
- Nothing is saved to disk. If Google is down, the last copy stays in memory.
- No npm packages. `server.js` and `tagging.js` only use what comes with Node.

## Downloads and tagging

- **Files are always the original upload at original quality.** Nothing is converted, re-encoded or compressed. Playback and downloads both use pillows' `/api/download` (the original file), not `/api/get`, which is a much smaller compressed streaming copy. The only change made to a file is the tags, and the audio inside is bit-for-bit the same (checked by decoding before and after).
- Downloaded files keep the original upload's extension. If the upload has an odd one (a WAV named `.raw`), the real type is used instead.

- Each song's Download button and the era page's "Download era ZIP" both go through the server so the files come out tagged (`tagging.js`, ported from tracker-player's tagger): title (with features), artist and album artist "Yeat", the era as the album, the era's year, genre, track number in the ZIP, the producer credit as the comment, and the era cover.
- MP3 gets ID3v2.3, Ogg/Opus gets Vorbis comments, FLAC gets a comment block and picture, WAV gets an ID3 chunk. M4A is passed through untagged.
- The era ZIP lets you pick everything / unreleased only / released only, and skip snippets and partials. Files that appear on both the Unreleased and Released tabs are only included once. It also has the cover and a `tracklist.txt` (anything that failed to download is listed at the bottom).
- The ZIP is streamed while it's built, so it starts right away. Downloads do pass through the server, so on a hosted copy they use the server's bandwidth.

## Pages

- `/` - search, status filter (All / Unreleased / Released / Unsurfaced), advanced search, and the era grid
- `/era/<era>` - era cover, description, timeline, songs grouped by session, Play era / Shuffle / Download era ZIP
- `/song/<id>` - opens that song's era with the song expanded (this is what Share copies)
- `/download/<id>` - one tagged song
- `/zip/era/<era>?which=all|unreleased|released&full=1` - the era ZIP
- `/tab/snippets`, `/tab/stems`, `/tab/lives`, `/tab/videos`, `/tab/performances`, `/tab/samples`, `/tab/extras`

## Era covers

Covers come from the tracker itself first (the picture in each era's header row, read from the sheet's HTML view and served through `/cover/<era>`, the same way tracker-player does it), then `cover-links.json`, then the Art tab. Discord attachment links expire, so they're tried last. To fix a cover, paste a direct image link next to the era name in `cover-links.json` and restart.

Collaboration with 2kthagoon has no picture in its header row on the tracker, so it shows the era name. Paste a direct image link next to it in `cover-links.json` to give it one.

## Settings (environment variables)

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | 3000 | Port to listen on (moves up if busy, except in public mode) |
| `PUBLIC` | off | Set to 1 on a server: 127.0.0.1 only, fixed port, download limits |
| `HOST` | all addresses (127.0.0.1 in public mode) | Address to listen on |
| `OPEN_BROWSER` | off | Set to 1 to open the browser on start (the start files do this) |
| `MAX_ZIPS` | 6 (2 in public mode) | Era ZIPs allowed at once (one per visitor) |
| `MAX_SONG_DOWNLOADS` | 20 (6 in public mode) | Single-song downloads allowed at once |
| `SHEET_ID` | the Yeat tracker | Point it at a different tracker sheet |
| `REFRESH_MINUTES` | 15 | How often the sheet is re-read |
