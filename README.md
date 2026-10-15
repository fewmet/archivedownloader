# archivedownloader

**This is a port of [The Ultimate Uzi Archive](https://uziarchive.top) (uziarchive.top), the Lil Uzi Vert archive run by @flexbymistake.** The idea, the layout and the features all come from their site. archivedownloader is the same thing remade to read other artists' trackers. If you like it, go use the original.

It reads an artist's tracker sheet and shows every song by era, with search, filters, a player, and tagged downloads. 34 artists are built in (the bar at the top of the page), and anyone can paste the link to any other tracker with "+ Any tracker".

## Credits

- **Original site, design and feature set:** [The Ultimate Uzi Archive](https://uziarchive.top). Their credits page lists:
    - **zdb** (@zdb_): Song & Snippet Tracker
    - **Bully** (@localbully88): Studio Session Archive, Lives Archive, Snippets Archive
    - **Flex By Mistake** (@flexbymistake): Site Creator, Performances Archive, Snippets Archive, Lives Archive
    - **Overlord** (@wrldoverlord): Song & Snippet Tracker, File Archive
- **Yeat song data:** the [Yeat Trackër](https://docs.google.com/spreadsheets/d/1FUzAZyTCgFTVxQ--qbCAS2bUk4dsAw6ASxwjURPHbyI/edit), edited by **raglord**, **red.**, **shock**, **Snarke** and **zamfir**.
- **Every other artist:** their own tracker. Each artist's Credits page names the tracker and its editors, taken from [TrackerHub](https://docs.google.com/spreadsheets/d/1Z8aANbxXbnUGoZPRvJfWL3gz6jrzPPrwVt3d0c1iJ_4/edit).
- **Files:** hosted on pillows.su, pixeldrain, imgur.gg and a few others. Nothing is hosted here.

None of them make or run this port, so problems with it shouldn't go to them.

## Run it on your PC

Double-click `Start archivedownloader (Windows).bat` (or `Start archivedownloader (Mac).command` on a Mac). The site opens in your browser. Close the black window to stop it.

There's nothing to install. If the computer doesn't have Node.js 18+, the start file downloads a private copy into a `runtime` folder the first time. `HOW TO RUN.txt` has the plain-English version for other people.

From a terminal you can also run `node server.js`. If port 3000 is taken it moves to 3001, 3002 and so on.

## Artists

- `artists.json` is the built-in list, in the order the artist bar shows it: the address (`/uzi`), the name, the tracker (a Google Sheet id, or `site` for trackers that are their own website like tylertracker.net), and the artist's colour. It came from tracker-player's list.
- Yeat is the main artist and lives at `/`. Every other artist lives at `/<key>`, like `/uzi/era/luv-is-rage`.
- **+ Any tracker** takes any Google Sheets tracker link (or tylertracker.net, asaprockytracker.net, deftonestracker.net). It gets its own address, `/sheet-<sheet id>`, so it can be shared like any other page. Trackers a visitor adds are remembered in their browser and shown in their artist bar.
- An artist is only read from Google when someone opens it, then kept in memory. On the public server only a few are kept at once; the one used longest ago is let go first.

## How a tracker is read (`tracker.js`)

- Everything comes from the sheet's published HTML view, not the CSV export. That still works on trackers that turned off downloading (Uzi, Ken Carson, Juice WRLD, OsamaSon and others), keeps hyperlinks, and shows pictures pasted into cells (where era covers live).
- The tab list is read from the sheet, and only tabs with songs or files are used: Unreleased and Released (together they're the Songs page), Art (for covers), and when the tracker has them Snippets, Stems, Lives, Music Videos, Performances, Samples and Misc (shown as Extras). Recent, Best Of, Special, Grails, Wanted, Worst Of, Tracklists, Key, Fakes, Groupbuys, Socials, Album Copies, templates and the like are left out on purpose: they're filtered copies of Unreleased or not songs. A tab that ends up with nothing to open is dropped too.
- Columns are found by their header name, not position, because they move around between trackers (Era / Rec. Era / Album, Available Length / Portion / Availability, Link(s) / Links / Main Links / Download(s) / Source, and so on).
- Era heading rows are recognised by the tally formula, the "℗ year" line, the era picture, or a timeline in the notes. Era covers come from the picture in each era's heading, then `covers/<artist>.json`, then the Art tab.
- Playable files: pillows.su, pixeldrain (old and new links), catbox, imgur.gg, exoshare and Google Drive. krakenfiles and music.froste.lol only give download pages, so those songs show as unplayable.

## Downloads and tagging

- **Files are always the original upload at original quality.** Nothing is converted, re-encoded or compressed. Playback and downloads both use the original file (for pillows that's `/api/download`, not the smaller `/api/get` streaming copy). The only change made to a file is the tags.
- Each song's Download button and the era page's "Download era ZIP" go through the server so the files come out tagged (`tagging.js`, ported from tracker-player's tagger): title (with features), the artist, the era as the album, the era's year, genre, track number in the ZIP, the producer credit as the comment, and the era cover.
- MP3 gets ID3v2.3, Ogg/Opus gets Vorbis comments, FLAC gets a comment block and picture, WAV gets an ID3 chunk. M4A is passed through untagged.
- The era ZIP lets you pick everything / unreleased only / released only, and skip snippets and partials. It also has the cover and a `tracklist.txt`.
- Downloads pass through the server, so on a hosted copy they use the server's bandwidth.

## Era covers you add by hand

`covers/<artist key>.json` (copied from tracker-player's cover-links files) maps era names to image links. A link there beats the Art tab. Discord attachment links expire, so they're tried last.

## Settings (environment variables)

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | 3000 | Port to listen on (moves up if busy, except in public mode) |
| `PUBLIC` | off | Set to 1 on a server: 127.0.0.1 only, fixed port, tighter limits |
| `HOST` | all addresses (127.0.0.1 in public mode) | Address to listen on |
| `OPEN_BROWSER` | off | Set to 1 to open the browser on start (the start files do this) |
| `DEFAULT_ARTIST` | yeat | The artist at `/` |
| `ALLOW_CUSTOM` | on | Set to 0 to turn off "+ Any tracker" |
| `MAX_ARTISTS` | 12 (3 in public mode) | Artists kept in memory at once |
| `MAX_LOADS` | 4 (2 in public mode) | Trackers read from Google at the same time |
| `MAX_ZIPS` | 6 (2 in public mode) | Era ZIPs allowed at once (one per visitor) |
| `MAX_SONG_DOWNLOADS` | 20 (6 in public mode) | Single-song downloads allowed at once |
| `REFRESH_MINUTES` | 15 | How often an open artist's tracker is re-read |

On a 1 GB server, also run Node with `--max-old-space-size=256` and `MALLOC_ARENA_MAX=2` (the hosting guide does this).
