/*
  archivedownloader server

  A port of The Ultimate Uzi Archive (https://uziarchive.top, run by
  @flexbymistake). The idea, layout and features come from that site; this is
  the same thing pointed at any artist's tracker: the built-in list in
  artists.json, or any tracker link someone pastes in.

  Nothing is stored on this server: songs play straight from the file hosts
  in the visitor's browser. Downloads and ZIPs pass through it so the files
  can be tagged.

  Run:  node server.js   (Node 18 or newer, no npm install needed)
  Or double-click "Start archivedownloader" - it does everything for you.
*/

const http = require("http");
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const { tagAudio, cleanTitle } = require("./tagging");
const tracker = require("./tracker");

if (typeof fetch !== "function") {
  console.error("This needs Node.js 18 or newer. Get it from https://nodejs.org");
  process.exit(1);
}


const PORT = Number(process.env.PORT) || 3000;
// PUBLIC=1 is for running on a server behind Caddy: listen on 127.0.0.1 only,
// stay on the given port (Caddy points at it), and never open a browser
const PUBLIC_MODE = process.env.PUBLIC === "1";
const HOST = process.env.HOST || (PUBLIC_MODE ? "127.0.0.1" : undefined);
// downloads are the heavy part on a small server, so only a few run at once
const MAX_ZIPS = Number(process.env.MAX_ZIPS) || (PUBLIC_MODE ? 2 : 6);
const MAX_SONG_DOWNLOADS = Number(process.env.MAX_SONG_DOWNLOADS) || (PUBLIC_MODE ? 6 : 20);
// how many artists stay loaded in memory at once (the least recently used one goes first)
// (on the Oracle server the service also runs Node with --max-old-space-size=256
// and MALLOC_ARENA_MAX=2, which keeps big trackers like Kanye's from hogging memory)
const MAX_ARTISTS = Number(process.env.MAX_ARTISTS) || (PUBLIC_MODE ? 3 : 12);
// how many trackers can be read from Google at the same time
const MAX_LOADS = Number(process.env.MAX_LOADS) || (PUBLIC_MODE ? 2 : 4);
const REFRESH_MINUTES = Number(process.env.REFRESH_MINUTES) || 15;
const ALLOW_CUSTOM = process.env.ALLOW_CUSTOM !== "0";

const { clean, looseKey } = tracker;

/* ---------- the built-in artists ---------- */

const ARTIST_FILE = path.join(__dirname, "artists.json");
const registry = JSON.parse(fs.readFileSync(ARTIST_FILE, "utf8"));
const BUILT_IN = new Map(registry.artists.map(artist => [artist.key, artist]));
const DEFAULT_ARTIST = process.env.DEFAULT_ARTIST || registry.defaultArtist || registry.artists[0].key;

function readCovers(key) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(__dirname, "covers", `${key}.json`), "utf8"));
    return data.covers || data;
  } catch {
    return {};
  }
}

const sourceOf = artist => (artist.site ? { site: artist.site } : { sheetId: artist.sheetId });

// a built-in artist whose tracker is the same sheet someone pasted
function builtInFor(source) {
  for (const artist of BUILT_IN.values()) {
    if (source.sheetId && artist.sheetId === source.sheetId) return artist;
    if (source.site && artist.site === source.site) return artist;
  }
  return null;
}

/* ---------- TrackerHub: who keeps each tracker ----------
   TrackerHub is the community's list of trackers, with the people who keep
   each one. It's read once in a while so every artist's Credits page can name
   the tracker's editors, including trackers someone pastes in. */

const HUB_SHEET = "1Z8aANbxXbnUGoZPRvJfWL3gz6jrzPPrwVt3d0c1iJ_4";
const HUB_TAB = "1884837542";
let hub = { at: 0, byKey: new Map(), loading: null };

async function loadHub() {
  const html = await tracker.fetchText(`https://docs.google.com/spreadsheets/d/${HUB_SHEET}/htmlview/sheet?headers=true&gid=${HUB_TAB}`, 30000);
  const rows = tracker.parseSheetHtml(html);
  const byKey = new Map();
  rows.forEach(row => {
    const name = clean(row.cells[0]).replace(/^[^\p{L}\p{N}]+/u, "").replace(/\s+/g, " ").trim();
    const credits = clean(row.cells[1]).replace(/\s*\n\s*/g, " ").trim();
    const link = (row.links[0] || []).map(url => tracker.parseTrackerLink(url)).find(Boolean);
    if (!name || !link || !credits || /^credits$/i.test(credits)) return;
    const key = tracker.sourceKey(link);
    if (!byKey.has(key)) byKey.set(key, { name, credits });
  });
  hub = { at: Date.now(), byKey, loading: null };
  console.log(`[hub] ${byKey.size} trackers listed on TrackerHub`);
}

async function hubInfo(source) {
  if (!hub.at || Date.now() - hub.at > 12 * 60 * 60 * 1000) {
    if (!hub.loading) hub.loading = loadHub().catch(err => { console.warn("[hub]", err.message); hub.loading = null; });
    // don't hold a page up for long waiting on it
    await Promise.race([hub.loading, new Promise(resolve => setTimeout(resolve, hub.at ? 0 : 6000))]);
  }
  return hub.byKey.get(tracker.sourceKey(source)) || null;
}

function splitCredits(text) {
  return String(text || "")
    .split(/,|\s&\s|\band\b/)
    .map(name => name.replace(/^\s*@?/, "").trim())
    .filter(name => name && name.length <= 40 && !/^(idk|etc\.?|and more)$/i.test(name));
}

/* ---------- loading artists ---------- */

const artists = new Map(); // key -> { def, data, json, at, used, loading }
let activeLoads = 0;
const loadQueue = [];

function withLoadSlot(job) {
  return new Promise((resolve, reject) => {
    const run = () => {
      activeLoads++;
      job().then(resolve, reject).finally(() => {
        activeLoads--;
        const next = loadQueue.shift();
        if (next) next();
      });
    };
    if (activeLoads < MAX_LOADS) run(); else loadQueue.push(run);
  });
}

function artistDef(key) {
  if (BUILT_IN.has(key)) {
    const artist = BUILT_IN.get(key);
    return { ...artist, source: sourceOf(artist), builtIn: true };
  }
  if (!ALLOW_CUSTOM) return null;
  const source = tracker.sourceFromKey(key);
  if (!source) return null;
  const same = builtInFor(source);
  if (same) return { ...same, source: sourceOf(same), builtIn: true };
  return { key, name: "", source, accent: "", builtIn: false };
}

// JSON is kept gzipped only: about a sixth of the memory, and almost every browser takes it that way
function packJson(text) {
  return { gz: zlib.gzipSync(text, { level: 6 }) };
}

async function buildArtist(def) {
  const data = await tracker.loadTracker({
    artistKey: def.key,
    source: def.source,
    fallbackTabs: def.fallbackTabs || {},
    manualCovers: def.builtIn ? readCovers(def.key) : {}
  });

  const info = await hubInfo(def.source).catch(() => null);
  const name = def.name || (info && info.name.replace(/\s*\[[^\]]*\]\s*$/, "")) || tracker.guessArtistName(data.title);
  const credits = def.credits || (info ? splitCredits(info.credits) : []);

  const artist = {
    key: def.key,
    name,
    accent: def.accent || "",
    builtIn: def.builtIn,
    trackerName: def.trackerName || data.title || `${name} Tracker`,
    sheetUrl: data.sheetUrl,
    credits
  };

  const json = {
    meta: packJson(JSON.stringify({
      updatedAt: new Date().toISOString(),
      artist,
      sheetUrl: data.sheetUrl,
      eras: data.eras,
      tabs: data.tabs
    })),
    songs: packJson(JSON.stringify(data.songs))
  };
  Object.entries(data.sections).forEach(([key, items]) => { json[key] = packJson(JSON.stringify(items)); });

  return { artist, data, json };
}

function evict() {
  if (artists.size <= MAX_ARTISTS) return;
  const idle = [...artists.entries()]
    .filter(([, entry]) => entry.data && !entry.loading && !entry.pinned)
    .sort((a, b) => a[1].used - b[1].used);
  while (artists.size > MAX_ARTISTS && idle.length) {
    const [key] = idle.shift();
    artists.delete(key);
    console.log(`[cache] let go of ${key} to save memory`);
  }
}

// the artist's data, loading it the first time; stale data is served while a fresh copy loads
async function getArtist(key) {
  const def = artistDef(key);
  if (!def) {
    const err = new Error("There's no artist or tracker at that address.");
    err.status = 404;
    throw err;
  }
  let entry = artists.get(def.key);
  if (!entry) {
    entry = { def, data: null, json: null, artist: null, at: 0, used: Date.now(), loading: null, pinned: def.key === DEFAULT_ARTIST };
    artists.set(def.key, entry);
  }
  entry.used = Date.now();

  const load = () => {
    if (!entry.loading) {
      entry.loading = withLoadSlot(() => buildArtist(def))
        .then(built => {
          Object.assign(entry, built, { at: Date.now() });
          evict();
        })
        .finally(() => { entry.loading = null; });
    }
    return entry.loading;
  };

  if (!entry.data) {
    try {
      await load();
    } catch (err) {
      artists.delete(def.key);
      err.status = err.status || 502;
      throw err;
    }
  } else if (Date.now() - entry.at > REFRESH_MINUTES * 60 * 1000) {
    load().catch(err => console.warn(`[${def.key}] refresh failed:`, err.message));
  }
  return entry;
}

// keep the main artist loaded and fresh
setInterval(() => getArtist(DEFAULT_ARTIST).catch(() => {}), REFRESH_MINUTES * 60 * 1000).unref();

/* ---------- web server ---------- */

const PUBLIC_DIR = path.join(__dirname, "public");
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

const wantsGzip = req => /gzip/.test(req.headers["accept-encoding"] || "");

function send(req, res, status, body, type, cacheSeconds = 0) {
  const headers = { "Content-Type": type };
  if (cacheSeconds) headers["Cache-Control"] = `public, max-age=${cacheSeconds}`;
  let data = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  if (data.length > 1024 && wantsGzip(req) && !/image\/(png|x-icon)/.test(type)) {
    data = zlib.gzipSync(data);
    headers["Content-Encoding"] = "gzip";
    headers["Vary"] = "Accept-Encoding";
  }
  headers["Content-Length"] = data.length;
  res.writeHead(status, headers);
  res.end(req.method === "HEAD" ? undefined : data);
}

// a prebuilt JSON body, gzipped once and kept with the artist
function sendPacked(req, res, packed) {
  const headers = { "Content-Type": TYPES[".json"], "Cache-Control": "public, max-age=120", "Vary": "Accept-Encoding" };
  let data;
  if (wantsGzip(req)) {
    data = packed.gz;
    headers["Content-Encoding"] = "gzip";
  } else {
    data = zlib.gunzipSync(packed.gz);
  }
  headers["Content-Length"] = data.length;
  res.writeHead(200, headers);
  res.end(req.method === "HEAD" ? undefined : data);
}

const sendJson = (req, res, status, body) =>
  send(req, res, status, typeof body === "string" ? body : JSON.stringify(body), TYPES[".json"], status === 200 ? 120 : 0);

const sendText = (req, res, status, text) => send(req, res, status, text, "text/plain; charset=utf-8");

function sendFile(req, res, file) {
  fs.readFile(file, (err, data) => {
    if (err) return sendText(req, res, 404, "Not found");
    const ext = path.extname(file);
    send(req, res, 200, data, TYPES[ext] || "application/octet-stream", ext === ".html" ? 0 : 300);
  });
}

/* ---------- file hosts ---------- */

const imgurCache = new Map();
const exoCache = new Map();

async function resolveImgur(id) {
  if (imgurCache.has(id)) return imgurCache.get(id);
  const page = await (await fetch(`https://imgur.gg/f/${id}`, { signal: AbortSignal.timeout(20000) })).text();
  const found = page.match(/<meta[^>]+property="og:(?:audio|video)"[^>]+content="([^"]+)"/i) ||
    page.match(new RegExp(`https://[a-z]\\.imgur\\.gg/${id}-[^"'\\s<>]+`));
  const direct = found ? (found[1] || found[0]) : null;
  if (direct) {
    if (imgurCache.size > 5000) imgurCache.clear();
    imgurCache.set(id, direct);
  }
  return direct;
}

const AUDIO_NAME = /\.(mp3|m4a|wav|flac|ogg|opus|aac|aiff?|alac|mp4|webm|mov)$/i;

// exoshare shares are folders; the first audio file in one is the song
async function resolveExoshare(id) {
  if (exoCache.has(id)) return exoCache.get(id);
  const response = await fetch(`https://exoshare.org/api/shares/${id}`, {
    headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) return null;
  const share = await response.json();
  const files = (Array.isArray(share.files) ? share.files : [])
    .filter(file => AUDIO_NAME.test(file.name || ""))
    .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
  // a real audio file first; a video only when that's all the share has
  const rank = name => (/\.(mp3|wav|flac|ogg|opus|aiff?)$/i.test(name) ? 0 : /\.(m4a|aac|alac)$/i.test(name) ? 1 : 2);
  const file = files.slice().sort((a, b) => rank(a.name) - rank(b.name))[0];
  const url = file ? `https://exoshare.org/api/shares/${id}/files/${file.id}` : null;
  if (exoCache.size > 5000) exoCache.clear();
  exoCache.set(id, url);
  return url;
}

const driveDownloadUrl = id => `https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download&confirm=t`;

// only ever fetches from the hosts the songs actually live on
async function sourceUrl(song) {
  const audio = song.audio;
  if (!audio) return null;
  const link = id => song.links.find(l => id(l));
  switch (audio.host) {
    case "pillows": return `https://api.pillows.su/api/download/${tracker.pillowsId(link(tracker.pillowsId))}`;
    case "pixeldrain": return audio.src.startsWith("https://pixeldrain.com/") ? audio.src : null;
    case "catbox": return tracker.catboxFile(audio.src);
    case "imgur": return resolveImgur(tracker.imgurGgId(link(tracker.imgurGgId)));
    case "exoshare": return resolveExoshare(tracker.exoshareId(link(tracker.exoshareId)));
    case "drive": return driveDownloadUrl(tracker.driveId(link(tracker.driveId)));
    default: return null;
  }
}

async function fetchAudio(song) {
  const url = await sourceUrl(song);
  if (!url) throw new Error("no file link");
  const response = await fetch(url, { signal: AbortSignal.timeout(180000), headers: { "User-Agent": "Mozilla/5.0" } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const type = (response.headers.get("content-type") || "").toLowerCase();
  if (/text\/html|application\/json/.test(type)) throw new Error("the host sent a web page, not a file");
  const audio = Buffer.from(await response.arrayBuffer());
  if (!audio.length) throw new Error("empty file");
  return { audio, response, url };
}

// cover links come out of other people's sheets, so only plain public https addresses are fetched
function safeRemote(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    if (host === "localhost" || /\.(local|internal|lan|home)$/.test(host)) return false;
    if (/^[\d.]+$/.test(host) || host.includes(":")) return false;
    return true;
  } catch {
    return false;
  }
}

/* ---------- covers ---------- */

const sheetImageBytes = new Map(); // "artist/era" -> { at, url, type, body }

async function sheetCoverImage(artistKey, era) {
  if (!era || !era.sheetCover || !safeRemote(era.sheetCover)) return null;
  const id = `${artistKey}/${era.key}`;
  const held = sheetImageBytes.get(id);
  if (held && Date.now() - held.at < 6 * 60 * 60 * 1000 && held.url === era.sheetCover) return held;

  // Google now and then refuses one of a burst of requests; one retry helps
  let response = await fetch(era.sheetCover, { signal: AbortSignal.timeout(20000) }).catch(() => null);
  if (!response || !response.ok) {
    await new Promise(resolve => setTimeout(resolve, 600));
    response = await fetch(era.sheetCover, { signal: AbortSignal.timeout(20000) }).catch(() => null);
  }
  const type = response && (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!response || !response.ok || !/^image\//.test(type)) return null;
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > 8 * 1024 * 1024) return null;

  const image = { at: Date.now(), url: era.sheetCover, type, body };
  if (sheetImageBytes.size > 200) sheetImageBytes.clear();
  sheetImageBytes.set(id, image);
  return image;
}

// the era cover, fetched once and kept for tagging and the ZIP's cover file
const coverCache = new Map();

async function eraCover(artistKey, era) {
  if (!era) return null;
  const id = `${artistKey}/${era.key}`;
  if (coverCache.has(id)) return coverCache.get(id);
  let found = null;
  for (const link of era.covers || []) {
    try {
      if (link.startsWith("/cover/")) {
        const image = await sheetCoverImage(artistKey, era);
        if (image && /^image\/(jpeg|png)$/.test(image.type)) { found = { mime: image.type, image: image.body }; break; }
        continue;
      }
      if (!safeRemote(link)) continue;
      const response = await fetch(link, { signal: AbortSignal.timeout(15000) });
      const mime = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (!response.ok || !/^image\/(jpeg|jpg|png)$/.test(mime)) continue;
      const image = Buffer.from(await response.arrayBuffer());
      if (!image.length || image.length > 8 * 1024 * 1024) continue;
      found = { mime: mime === "image/jpg" ? "image/jpeg" : mime, image };
      break;
    } catch { /* next one */ }
  }
  if (coverCache.size > 200) coverCache.clear();
  coverCache.set(id, found);
  return found;
}

/* ---------- era ZIP download ----------
   Built on the fly and streamed, so nothing is written to disk and the
   download starts straight away. Files are stored as-is (audio doesn't
   shrink when zipped). Zip64 kicks in by itself if an era passes 4 GB. */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(crc, buf) {
  crc = ~crc >>> 0;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return ~crc >>> 0;
}

function dosTime(date) {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}

function safeName(text) {
  return String(text || "untitled")
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/, "")
    .trim()
    .slice(0, 120) || "untitled";
}

const AUDIO_EXT = {
  "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/aac": "aac",
  "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav", "audio/flac": "flac", "audio/x-flac": "flac",
  "audio/ogg": "ogg", "audio/opus": "opus", "video/mp4": "mp4", "audio/webm": "webm", "image/jpeg": "jpg",
  "image/png": "png", "image/webp": "webp", "image/gif": "gif"
};

// the file keeps the extension of the original upload; sniffing the bytes is
// only the fallback (a QuickTime .mov looks like an .mp4 from its header)
function originalExt(response, url, result) {
  const disposition = response.headers.get("content-disposition") || "";
  const named = disposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)/i);
  let name = "";
  try { name = named ? decodeURIComponent(named[1]) : ""; } catch { name = named ? named[1] : ""; }
  const fromName = name.match(/\.([a-z0-9]{2,5})$/i);
  const known = /^(mp3|wav|flac|ogg|opus|oga|m4a|mp4|mov|aac|aif|aiff|alac|wma|webm)$/;
  if (fromName && known.test(fromName[1].toLowerCase())) return fromName[1].toLowerCase();
  // an upload named something odd ("Loot.raw" is really a WAV) gets the type its bytes are
  return (result && result.ext) || (fromName ? fromName[1].toLowerCase() : extFor(response, url));
}

function extFor(response, url) {
  const disposition = response.headers.get("content-disposition") || "";
  const named = disposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)/i);
  const fromName = named && decodeURIComponent(named[1]).match(/\.([a-z0-9]{2,5})$/i);
  if (fromName) return fromName[1].toLowerCase();
  const type = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (AUDIO_EXT[type]) return AUDIO_EXT[type];
  const fromUrl = String(url).split("?")[0].match(/\.([a-z0-9]{2,5})$/i);
  return fromUrl ? fromUrl[1].toLowerCase() : "mp3";
}

class ZipStream {
  constructor(res) {
    this.res = res;
    this.offset = 0;
    this.entries = [];
    this.closed = false;
    res.on("close", () => { this.closed = true; });
  }

  async write(buf) {
    if (this.closed) throw new Error("client went away");
    this.offset += buf.length;
    if (!this.res.write(buf)) await new Promise(resolve => {
      const done = () => { this.res.off("drain", done); this.res.off("close", done); resolve(); };
      this.res.on("drain", done);
      this.res.on("close", done);
    });
  }

  // chunks: an async iterable of Buffers / Uint8Arrays
  async add(name, chunks, when = new Date()) {
    const nameBuf = Buffer.from(name, "utf8");
    const { time, date } = dosTime(when);
    const start = this.offset;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0x0808, 6);       // sizes in data descriptor + UTF-8 names
    local.writeUInt16LE(0, 8);            // stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt16LE(nameBuf.length, 26);
    await this.write(Buffer.concat([local, nameBuf]));

    let crc = 0;
    let size = 0;
    for await (const chunk of chunks) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      crc = crc32(crc, buf);
      size += buf.length;
      await this.write(buf);
    }

    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc, 4);
    descriptor.writeUInt32LE(size, 8);
    descriptor.writeUInt32LE(size, 12);
    await this.write(descriptor);

    this.entries.push({ nameBuf, time, date, crc, size, start });
  }

  async finish() {
    const centralStart = this.offset;
    for (const entry of this.entries) {
      const bigOffset = entry.start > 0xfffffffe;
      const extra = bigOffset ? Buffer.alloc(12) : Buffer.alloc(0);
      if (bigOffset) {
        extra.writeUInt16LE(0x0001, 0);
        extra.writeUInt16LE(8, 2);
        extra.writeBigUInt64LE(BigInt(entry.start), 4);
      }
      const head = Buffer.alloc(46);
      head.writeUInt32LE(0x02014b50, 0);
      head.writeUInt16LE(bigOffset ? 45 : 20, 4);
      head.writeUInt16LE(bigOffset ? 45 : 20, 6);
      head.writeUInt16LE(0x0808, 8);
      head.writeUInt16LE(0, 10);
      head.writeUInt16LE(entry.time, 12);
      head.writeUInt16LE(entry.date, 14);
      head.writeUInt32LE(entry.crc, 16);
      head.writeUInt32LE(entry.size, 20);
      head.writeUInt32LE(entry.size, 24);
      head.writeUInt16LE(entry.nameBuf.length, 28);
      head.writeUInt16LE(extra.length, 30);
      head.writeUInt32LE(bigOffset ? 0xffffffff : entry.start, 42);
      await this.write(Buffer.concat([head, entry.nameBuf, extra]));
    }
    const centralSize = this.offset - centralStart;
    const count = this.entries.length;

    if (centralStart > 0xfffffffe || count > 0xfffe) {
      const zip64End = this.offset;
      const rec = Buffer.alloc(56);
      rec.writeUInt32LE(0x06064b50, 0);
      rec.writeBigUInt64LE(44n, 4);
      rec.writeUInt16LE(45, 12);
      rec.writeUInt16LE(45, 14);
      rec.writeBigUInt64LE(BigInt(count), 24);
      rec.writeBigUInt64LE(BigInt(count), 32);
      rec.writeBigUInt64LE(BigInt(centralSize), 40);
      rec.writeBigUInt64LE(BigInt(centralStart), 48);
      const locator = Buffer.alloc(20);
      locator.writeUInt32LE(0x07064b50, 0);
      locator.writeBigUInt64LE(BigInt(zip64End), 8);
      locator.writeUInt32LE(1, 16);
      await this.write(Buffer.concat([rec, locator]));
    }

    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(Math.min(count, 0xffff), 8);
    end.writeUInt16LE(Math.min(count, 0xffff), 10);
    end.writeUInt32LE(Math.min(centralSize, 0xffffffff), 12);
    end.writeUInt32LE(Math.min(centralStart, 0xffffffff), 16);
    await this.write(end);
    this.res.end();
  }
}



async function* once(buf) { yield buf; }

/* ---------- tagged downloads ---------- */

// what goes into the file: same fields tracker-player writes, plus track number
function tagsFor(artist, song, era, track) {
  const features = song.features.map(f => ` (${f})`).join("");
  return {
    title: cleanTitle(song.title) + features,
    artist: artist.name,
    albumArtist: artist.name,
    album: era ? era.name : (song.eraName || ""),
    year: era && era.year ? String(era.year) : "",
    genre: "Hip-Hop/Rap",
    comment: song.producers.length ? `prod. ${song.producers.join(", ")}` : "",
    track: track ? String(track) : ""
  };
}

function findItem(entry, id) {
  return entry.data.songs.find(song => song.id === id) ||
    Object.values(entry.data.sections).flat().find(item => item.id === id) || null;
}

function attachment(name) {
  return `attachment; filename="${name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "'")}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

async function sendTaggedSong(req, res, entry, id) {
  const song = findItem(entry, id);
  if (!song || !song.audio) return sendText(req, res, 404, "That song has no file to download.");
  const era = entry.data.eras.find(e => e.key === song.era) || null;
  try {
    const { audio, response, url } = await fetchAudio(song);
    const result = tagAudio(audio, tagsFor(entry.artist, song, era), await eraCover(entry.artist.key, era));
    const name = `${safeName(cleanTitle(song.title))}.${originalExt(response, url, result)}`;
    console.log(`[download] ${entry.artist.key}/${song.title}: ${result.kind}, ${result.tagged ? "tagged" : "sent as-is"}`);
    res.writeHead(200, {
      "Content-Type": response.headers.get("content-type") || "application/octet-stream",
      "Content-Length": result.file.length,
      "Content-Disposition": attachment(name),
      "Cache-Control": "no-store"
    });
    res.end(result.file);
  } catch (err) {
    console.warn(`[download] ${song.title}: ${err.message}`);
    sendText(req, res, 502, "Couldn't get that file from the host. Try again in a bit.");
  }
}

const SNIPPETISH = /^(snippet|partial|tagged|beat only|hq snippet|lq snippet)$/i;

async function sendEraZip(req, res, entry, eraKey, params) {
  const { artist, data } = entry;
  const era = data.eras.find(e => e.key === eraKey);
  if (!era) return sendText(req, res, 404, "No such era.");

  const fullOnly = params.get("full") === "1";
  const which = params.get("which") || "all"; // all | unreleased | released
  let songs = data.songs.filter(song => song.era === era.key && song.audio);
  if (which !== "all") songs = songs.filter(song => song.status === which);
  if (fullOnly) songs = songs.filter(song => !SNIPPETISH.test(song.available || ""));
  // a released song often points at the same file as its unreleased OG row
  const seenFiles = new Set();
  songs = songs.filter(song => !seenFiles.has(song.audio.src) && seenFiles.add(song.audio.src));
  if (!songs.length) return sendText(req, res, 404, "This era has no files to download with those settings.");

  const folder = safeName(`${artist.name} - ${era.name}`);
  res.writeHead(200, {
    "Content-Type": "application/zip",
    "Content-Disposition": attachment(`${folder}.zip`),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });

  const zip = new ZipStream(res);
  const used = new Set();
  const failed = [];
  const lines = [];
  const pad = String(songs.length).length;
  console.log(`[zip] ${artist.key}/${era.name}: ${songs.length} files`);

  try {
    // cover first, so the folder has art (the same picture goes into every file's tags)
    const cover = await eraCover(artist.key, era);
    if (cover) await zip.add(`${folder}/cover.${cover.mime === "image/png" ? "png" : "jpg"}`, once(cover.image));
    let tagged = 0;

    for (let i = 0; i < songs.length; i++) {
      const song = songs[i];
      const number = String(i + 1).padStart(pad, "0");
      const label = song.status === "released" ? "" : song.available && !/^(og file|full)$/i.test(song.available) ? ` [${song.available}]` : "";
      try {
        const { audio, response, url } = await fetchAudio(song);
        if (zip.closed) throw new Error("client went away");
        const result = tagAudio(audio, tagsFor(artist, song, era, i + 1), cover);
        if (result.tagged) tagged++;
        let name = `${number} - ${safeName(cleanTitle(song.title) + label)}.${originalExt(response, url, result)}`;
        if (used.has(name.toLowerCase())) name = name.replace(/(\.[^.]+)$/, ` (${i + 1})$1`);
        used.add(name.toLowerCase());
        await zip.add(`${folder}/${name}`, once(result.file));
        lines.push([number, song.title, song.status, song.available || song.type || "", song.length || "", song.producers.join(", ")].join("\t"));
      } catch (err) {
        if (zip.closed) throw err;
        failed.push(`${song.title}  (${err.message})`);
        console.warn(`[zip] ${era.name}: skipped "${song.title}": ${err.message}`);
      }
    }

    const info = [
      `${artist.name} - ${era.name}`,
      era.year ? `Year: ${era.year}` : "",
      `Downloaded ${new Date().toLocaleString()} with archivedownloader`,
      "archivedownloader is a port of The Ultimate Uzi Archive (uziarchive.top) by @flexbymistake.",
      `Song data from the ${artist.trackerName}${artist.credits.length ? `, kept by ${artist.credits.join(", ")}` : ""}.`,
      "",
      "#\tTitle\tStatus\tAvailable\tLength\tProducer",
      ...lines,
      ...(failed.length ? ["", "Couldn't download these:", ...failed] : [])
    ].filter((line, index) => line !== "" || index > 2).join("\r\n");
    await zip.add(`${folder}/tracklist.txt`, once(Buffer.from(info, "utf8")));
    await zip.finish();
    console.log(`[zip] ${era.name}: done, ${lines.length} files (${tagged} tagged), ${failed.length} skipped`);
  } catch (err) {
    console.warn(`[zip] ${era.name}: stopped (${err.message})`);
    res.destroy();
  }
}

/* ---------- routes ---------- */

const busy = { zips: 0, zipIps: new Set(), songs: 0 };

// behind Caddy the visitor's address is in X-Forwarded-For
function clientIp(req) {
  const forwarded = PUBLIC_MODE && String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || req.socket.remoteAddress || "?";
}

const ARTIST_KEY = /^[a-z0-9]{1,40}$|^sheet-[A-Za-z0-9_-]{25,80}$|^site-[a-z0-9.-]{3,80}$/;
const RESERVED = new Set(["api", "era", "song", "tab", "credits", "cover", "download", "zip", "imgur", "exo", "drive", "artists"]);

// is this the start of a page address for an artist? (/uzi, /sheet-1abc.../era/x)
function isArtistSegment(segment) {
  if (!segment || RESERVED.has(segment) || !ARTIST_KEY.test(segment)) return false;
  return BUILT_IN.has(segment) || (ALLOW_CUSTOM && Boolean(tracker.sourceFromKey(segment)));
}

async function withArtist(req, res, key, work) {
  let entry;
  try {
    entry = await getArtist(key);
  } catch (err) {
    console.warn(`[${key}]`, err.message);
    return sendJson(req, res, err.status || 502, { error: err.message || "The tracker couldn't be loaded." });
  }
  return work(entry);
}

async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  let route;
  try { route = decodeURIComponent(url.pathname); } catch { return sendText(req, res, 400, "Bad address"); }
  let match;

  if (route === "/api/artists") {
    return sendJson(req, res, 200, {
      defaultArtist: DEFAULT_ARTIST,
      allowCustom: ALLOW_CUSTOM,
      artists: registry.artists.map(({ key, name, accent }) => ({ key, name, accent }))
    });
  }

  // a pasted tracker link -> the address it lives at
  if (route === "/api/resolve") {
    const source = tracker.parseTrackerLink(url.searchParams.get("link"));
    if (!source) return sendJson(req, res, 400, { error: "That doesn't look like a tracker link. Paste the Google Sheets link (docs.google.com/spreadsheets/d/...)." });
    const same = builtInFor(source);
    if (same) return sendJson(req, res, 200, { key: same.key, name: same.name, builtIn: true });
    if (!ALLOW_CUSTOM) return sendJson(req, res, 403, { error: "Adding other trackers is turned off on this site." });
    const key = tracker.sourceKey(source);
    return withArtist(req, res, key, entry => sendJson(req, res, 200, { key, name: entry.artist.name, builtIn: false }));
  }

  match = route.match(/^\/api\/a\/([^/]+)\/meta$/);
  if (match) return withArtist(req, res, match[1], entry => sendPacked(req, res, entry.json.meta));

  match = route.match(/^\/api\/a\/([^/]+)\/tab\/([a-z]+)$/);
  if (match) {
    return withArtist(req, res, match[1], entry => {
      const packed = match[2] !== "meta" && entry.json[match[2]];
      return packed ? sendPacked(req, res, packed) : sendJson(req, res, 404, { error: "No such tab." });
    });
  }

  match = route.match(/^\/imgur\/([A-Za-z0-9]{5,12})$/);
  if (match) {
    try {
      const direct = await resolveImgur(match[1]);
      if (!direct) return sendText(req, res, 404, "File not found on imgur.gg");
      res.writeHead(302, { Location: direct });
      return res.end();
    } catch (err) {
      return sendText(req, res, 502, "imgur.gg did not answer");
    }
  }

  match = route.match(/^\/exo\/([A-Za-z0-9_-]{6,40})$/);
  if (match) {
    try {
      const direct = await resolveExoshare(match[1]);
      if (!direct) return sendText(req, res, 404, "That exoshare link is gone.");
      res.writeHead(302, { Location: direct });
      return res.end();
    } catch (err) {
      return sendText(req, res, 502, "exoshare did not answer");
    }
  }

  match = route.match(/^\/drive\/([A-Za-z0-9_-]{10,80})$/);
  if (match) {
    res.writeHead(302, { Location: driveDownloadUrl(match[1]) });
    return res.end();
  }

  // /cover/<artist>/<era>  (and the old /cover/<era> for the default artist)
  match = route.match(/^\/cover\/([^/]+)\/([^/]+)$/) || route.match(/^\/cover\/()([^/]+)$/);
  if (match) {
    return withArtist(req, res, match[1] || DEFAULT_ARTIST, async entry => {
      try {
        const era = entry.data.eras.find(e => e.key === match[2]);
        const image = await sheetCoverImage(entry.artist.key, era);
        if (!image) return sendText(req, res, 404, "No cover");
        res.writeHead(200, { "Content-Type": image.type, "Content-Length": image.body.length, "Cache-Control": "public, max-age=86400" });
        return res.end(req.method === "HEAD" ? undefined : image.body);
      } catch (err) {
        return sendText(req, res, 502, "Couldn't fetch that cover");
      }
    });
  }

  match = route.match(/^\/download\/([^/]+)\/([A-Za-z0-9_-]{6,16})$/) || route.match(/^\/download\/()([A-Za-z0-9_-]{6,16})$/);
  if (match) {
    if (busy.songs >= MAX_SONG_DOWNLOADS) return sendText(req, res, 429, "Lots of downloads running right now. Try again in a minute.");
    return withArtist(req, res, match[1] || DEFAULT_ARTIST, async entry => {
      busy.songs++;
      try {
        return await sendTaggedSong(req, res, entry, match[2]);
      } finally {
        busy.songs--;
      }
    });
  }

  match = route.match(/^\/zip\/([^/]+)\/([^/]+)$/);
  if (match) {
    const artistKey = match[1] === "era" ? DEFAULT_ARTIST : match[1];
    const who = clientIp(req);
    if (busy.zips >= MAX_ZIPS || busy.zipIps.has(who)) {
      return sendText(req, res, 429, busy.zipIps.has(who)
        ? "You already have an era ZIP downloading. Wait for it to finish, then start the next one."
        : "Other people are downloading era ZIPs right now. Try again in a few minutes.");
    }
    return withArtist(req, res, artistKey, async entry => {
      busy.zips++;
      busy.zipIps.add(who);
      try {
        return await sendEraZip(req, res, entry, match[2], url.searchParams);
      } finally {
        busy.zips--;
        busy.zipIps.delete(who);
      }
    });
  }

  // real files in /public
  const file = path.normalize(path.join(PUBLIC_DIR, route));
  if (file.startsWith(PUBLIC_DIR + path.sep) && path.extname(file) && fs.existsSync(file)) {
    return sendFile(req, res, file);
  }

  // every page is drawn by the page itself
  const first = route.split("/")[1] || "";
  if (route === "/" || route === "/credits" || /^\/(era|song|tab)\//.test(route) || isArtistSegment(first)) {
    return sendFile(req, res, path.join(PUBLIC_DIR, "index.html"));
  }

  sendText(req, res, 404, "Not found");
}

function openBrowser(url) {
  const command = process.platform === "win32" ? `start "" "${url}"`
    : process.platform === "darwin" ? `open "${url}"`
    : `xdg-open "${url}"`;
  exec(command, () => {});
}

function listen(port, triesLeft = 20) {
  const server = http.createServer((req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405);
      return res.end();
    }
    handle(req, res).catch(err => {
      console.error(err);
      if (!res.headersSent) sendText(req, res, 500, "Something broke");
    });
  });

  server.once("error", err => {
    if (err.code === "EADDRINUSE" && triesLeft > 0 && !PUBLIC_MODE) return listen(port + 1, triesLeft - 1);
    console.error(err.message);
    process.exit(1);
  });

  server.listen(port, HOST, () => {
    const url = `http://${HOST && HOST !== "0.0.0.0" ? HOST : "localhost"}:${port}`;
    console.log("");
    console.log("  archivedownloader is running at " + url);
    if (PUBLIC_MODE) console.log("  Public mode: listening on " + url + " for Caddy");
    else console.log("  Keep this window open while you use it. Close it to stop.");
    console.log("");
    if (process.env.OPEN_BROWSER === "1" && !PUBLIC_MODE) openBrowser(url);
    getArtist(DEFAULT_ARTIST).catch(err => console.error(`[${DEFAULT_ARTIST}] first load failed:`, err.message));
    loadHub().catch(() => {});
  });
}

listen(PORT);
