/*
  archivedownloader server

  A port of The Ultimate Uzi Archive (https://uziarchive.top, run by
  @flexbymistake), remade for Yeat. The idea, layout and features come from
  that site; this is just the same thing pointed at the Yeat tracker.

  Reads the public Yeat tracker Google Sheet, turns every tab we care about
  into clean JSON, and serves the single-page site in /public.

  Nothing is stored on this server: songs stream straight from pillows.su in
  the visitor's browser, so the only traffic here is the page and the JSON.

  Run:  node server.js   (Node 18 or newer, no npm install needed)
  Or double-click "Start archivedownloader" - it does everything for you.
  Port: PORT env var, default 3000 (moves up if that port is busy)
*/

const http = require("http");
const zlib = require("zlib");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const { tagAudio, cleanTitle } = require("./tagging");

if (typeof fetch !== "function") {
  console.error("This needs Node.js 18 or newer. Get it from https://nodejs.org");
  process.exit(1);
}

// small CSV reader (quotes, commas and line breaks inside cells)
function parse(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const PORT = Number(process.env.PORT) || 3000;
// PUBLIC=1 is for running on a server behind Caddy: listen on 127.0.0.1 only,
// stay on the given port (Caddy points at it), and never open a browser
const PUBLIC_MODE = process.env.PUBLIC === "1";
const HOST = process.env.HOST || (PUBLIC_MODE ? "127.0.0.1" : undefined);
// downloads are the heavy part on a small server, so only a few run at once
const MAX_ZIPS = Number(process.env.MAX_ZIPS) || (PUBLIC_MODE ? 2 : 6);
const MAX_SONG_DOWNLOADS = Number(process.env.MAX_SONG_DOWNLOADS) || (PUBLIC_MODE ? 6 : 20);
const SHEET_ID = process.env.SHEET_ID || "1FUzAZyTCgFTVxQ--qbCAS2bUk4dsAw6ASxwjURPHbyI";
const REFRESH_MINUTES = Number(process.env.REFRESH_MINUTES) || 15;

/*
  Tabs on the tracker. "songs" is built from Unreleased + Released together;
  the rest are shown as their own sections, the same way uziarchive.top has
  Snippets / Lives / Performances / Extras next to Songs.
*/
const TABS = {
  unreleased: { gid: "1241081326" },
  released: { gid: "1617341558" },
  art: { gid: "1218331224" },
  snippets: { gid: "1806489895", label: "Snippets", order: 2 },
  stems: { gid: "2044190869", label: "Stems", order: 3 },
  lives: { gid: "1760266250", label: "Lives", order: 4 },
  videos: { gid: "1411615262", label: "Music Videos", order: 5 },
  performances: { gid: "445692614", label: "Performances", order: 6 },
  samples: { gid: "1886173549", label: "Samples", order: 7 },
  extras: { gid: "1670912096", label: "Extras", order: 8 }
};

const SECTION_KEYS = Object.keys(TABS).filter(key => TABS[key].label);

/* ---------- small helpers ---------- */

const clean = value => String(value == null ? "" : value).replace(/\r/g, "").trim();
const firstLine = value => clean(value).split("\n")[0].trim();

function makeId(...parts) {
  return crypto.createHash("sha1").update(parts.join("|")).digest("base64url").slice(0, 10);
}

// "Hold Ön" / "hold on" / "Deep Blue $trips" / "Deep Blue Strips" all compare equal
function looseKey(value) {
  return clean(value)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\$/g, "s")
    .toLowerCase()
    .replace(/[^a-z0-9\[\]]+/g, "");
}

function slugify(value) {
  const slug = clean(value)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\$/g, "s")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || makeId(value);
}

function extractLinks(cell) {
  return (clean(cell).match(/https?:\/\/[^\s"<>]+/g) || []).map(link => link.replace(/[),.]+$/, ""));
}

function pillowsId(link) {
  const match = String(link).match(/pillows\.su\/(?:f|api\/(?:get|download))\/([a-f0-9]{16,})/i);
  return match ? match[1] : null;
}

function imgurId(link) {
  const match = String(link).match(/imgur\.gg\/(?:f\/)?([A-Za-z0-9]{5,12})(?:[-.\/?#]|$)/);
  return match ? match[1] : null;
}

// the first link that is an actual audio file we can play in the browser
function pickAudio(links) {
  for (const link of links) {
    const id = pillowsId(link);
    if (id) {
      return {
        // /api/download is the original upload, byte for byte. /api/get is a smaller
        // streaming copy pillows makes (a 37 MB WAV comes back as about 1.4 MB),
        // so the player uses the original too. It supports seeking and CORS.
        src: `https://api.pillows.su/api/download/${id}`,
        download: `https://api.pillows.su/api/download/${id}`,
        page: `https://pillows.su/f/${id}`
      };
    }
  }
  // imgur.gg (used a lot for Lives and snippets) hides the file behind a page;
  // /imgur/:id looks the file up once and redirects the browser to it
  for (const link of links) {
    const id = imgurId(link);
    if (id && !/\.(png|jpe?g|gif|webp)(\?|$)/i.test(link)) {
      return { src: `/imgur/${id}`, download: `/imgur/${id}`, page: `https://imgur.gg/f/${id}` };
    }
  }
  return null;
}

/*
  The name cell looks like:
    BAND$
    (feat. Comethazine) (prod. ReeseyGotIt)
    (Band$, Bands)
  First line is the title, the bracket groups say who produced it, who is on
  it, and what else it has been called.
*/
function parseNameCell(cell) {
  const lines = clean(cell).split("\n").map(line => line.trim()).filter(Boolean);
  const title = lines[0] || "";
  const producers = [];
  const features = [];
  const aliases = [];
  const extra = [];

  lines.slice(1).forEach(line => {
    const groups = line.match(/\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g);
    if (!groups) {
      extra.push(line);
      return;
    }

    groups.forEach(group => {
      const inner = group.slice(1, -1).trim();
      const lower = inner.toLowerCase();

      if (/^prod\.?\s/.test(lower)) producers.push(inner.replace(/^prod\.?\s*(by\s*)?/i, ""));
      else if (/^(feat\.?|ft\.?|with)\s/.test(lower)) features.push(inner);
      else if (/^ref\.?\s/.test(lower)) features.push(inner);
      else inner.split(/,\s*/).forEach(alias => alias && aliases.push(alias));
    });
  });

  return { title, producers, features, aliases, extra };
}

const DATE_LIKE = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}$|^\d{4}$|^(early|mid|late)\s+\d{4}$|^\?{2,}/i;

function yearOf(value) {
  const match = clean(value).match(/\b(19|20)\d{2}\b/);
  return match ? Number(match[0]) : null;
}

/* ---------- sheet fetching ---------- */

async function fetchTab(gid) {
  // export?format=csv keeps every cell as text; the gviz endpoint guesses a
  // type per column and blanks out era names like "530" mixed with words
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${gid}`;
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`gid ${gid}: HTTP ${response.status}`);
  const text = await response.text();
  if (/^\s*<!doctype html/i.test(text)) throw new Error(`gid ${gid}: sheet is not public`);
  return parse(text);
}

function sheetRowUrl(gid, rowIndex) {
  return `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit?gid=${gid}#gid=${gid}&range=A${rowIndex + 1}`;
}

/* ---------- covers ---------- */

function readCoverLinks() {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(__dirname, "cover-links.json"), "utf8"));
    return data.covers || data;
  } catch {
    return {};
  }
}

// the Art tab lists every cover; the one named after the era itself is the era cover
function coversFromArtTab(rows) {
  const covers = new Map();
  rows.slice(1).forEach(row => {
    const era = clean(row[0]);
    const name = firstLine(row[1]);
    const type = clean(row[6]).toLowerCase();
    const use = clean(row[7]).toLowerCase();
    const link = extractLinks(row[8])[0];
    if (!era || !link || !/front cover/.test(type) || use === "unused") return;
    if (looseKey(name) === looseKey(era) && !covers.has(looseKey(era))) covers.set(looseKey(era), link);
    // any cover from that era, for eras with no cover of their own
    if (!covers.has("any:" + looseKey(era))) covers.set("any:" + looseKey(era), link);
  });
  return covers;
}

/* ---------- songs (Unreleased + Released) ---------- */

function parseEraHeader(row) {
  const lines = clean(row[1]).split("\n").map(line => line.trim()).filter(Boolean);
  const name = lines[0];
  const aliases = [];
  let label = "";
  let year = null;

  lines.slice(1).forEach(line => {
    if (line.includes("℗")) {
      year = yearOf(line);
      label = line.replace(/℗\s*(\d{4})?\s*/, "").trim();
    } else if (/^\(.*\)$/.test(line)) {
      line.replace(/^\(|\)$/g, "").split(/,\s*/).forEach(alias => alias && aliases.push(alias));
    }
  });

  return {
    name,
    aliases,
    year,
    label,
    stats: clean(row[0]).split("\n").filter(Boolean),
    timeline: clean(row[2]).split("\n").filter(Boolean),
    description: clean(row[6])
  };
}

// era header rows carry the "℗ 2021 ..." line, or a stats block in the first
// column like "84 Total Full / 77 OG Files ..." or "7 Mixtape Tracks / 1 Singles ..."
const STATS_CELL = /\d+\s+(total full|og files|(ep|mixtape|album) tracks|singles)/i;

function isEraHeaderRow(row, nameCol = 1) {
  if (extractLinks(row[row.length - 1]).length) return false;
  return clean(row[nameCol]).includes("℗") || STATS_CELL.test(clean(row[0]));
}

function buildSongs(unreleasedRows, releasedRows, artRows, sheetCovers = new Map()) {
  let creatingFromReleased = false;
  const eras = new Map(); // looseKey -> era
  const eraOrder = [];
  const songs = [];

  function eraFor(name) {
    const key = looseKey(name);
    if (!key) return null;
    if (eras.has(key)) return eras.get(key);
    for (const era of eras.values()) {
      if (era.aliases.some(alias => looseKey(alias) === key)) return era;
    }
    const era = {
      key: slugify(name),
      name,
      aliases: [],
      year: null,
      label: "",
      stats: [],
      timeline: [],
      description: "",
      releasedAs: [],
      cover: null,
      // an era that only shows up on the Released tab gets moved to where it belongs later
      late: creatingFromReleased
    };
    eras.set(key, era);
    eraOrder.push(era);
    return era;
  }

  /* Unreleased tab:
     Era | Name | Notes | Track Length | File Date | First Preview | Leak Date |
     OG File Leak Date | Type | Available Length | Quality | Link(s) */
  let currentEra = null;
  let currentSession = "";

  unreleasedRows.forEach((row, index) => {
    if (index === 0) return;

    if (isEraHeaderRow(row)) {
      const header = parseEraHeader(row);
      currentEra = eraFor(header.name);
      Object.assign(currentEra, { ...header, name: currentEra.name, releasedAs: currentEra.releasedAs, cover: currentEra.cover });
      currentSession = "";
      return;
    }

    const eraCell = clean(row[0]);
    const nameCell = clean(row[1]);
    if (!eraCell) {
      // a "2019 Sessions" style divider inside the era
      if (nameCell && !extractLinks(row[11]).length && !clean(row[8])) currentSession = firstLine(nameCell);
      return;
    }

    if (!nameCell) return;
    const era = eraFor(eraCell) || currentEra;
    const name = parseNameCell(nameCell);
    const links = extractLinks(row[11]);
    const audio = pickAudio(links);
    const linkNote = links.length ? "" : clean(row[11]);

    songs.push({
      id: makeId("u", eraCell, nameCell, row[11]),
      section: "unreleased",
      status: audio ? "unreleased" : "unsurfaced",
      era: era.key,
      session: currentSession,
      title: name.title,
      producers: name.producers,
      features: name.features,
      aliases: name.aliases,
      notes: clean(row[2]),
      length: clean(row[3]),
      fileDate: clean(row[4]),
      previewDate: clean(row[5]),
      leakDate: clean(row[6]),
      ogLeakDate: clean(row[7]),
      type: clean(row[8]),
      available: clean(row[9]),
      quality: clean(row[10]),
      links,
      linkNote,
      audio,
      sheet: sheetRowUrl(TABS.unreleased.gid, index)
    });
  });

  /* Released tab:
     Rec. Era | Rel. Era | Name | Notes | Track Length | Date | Type | Streaming | Link(s) */
  let currentRelease = "";
  creatingFromReleased = true;
  releasedRows.forEach((row, index) => {
    if (index === 0) return;

    if (isEraHeaderRow(row, 2)) {
      currentRelease = firstLine(row[2]);
      return;
    }

    const eraCell = clean(row[0]);
    const nameCell = clean(row[2]);
    if (!eraCell || !nameCell) return;

    const era = eraFor(eraCell);
    const name = parseNameCell(nameCell);
    const links = extractLinks(row[8]);
    const audio = pickAudio(links);
    const release = clean(row[1]) || currentRelease;
    if (release && !era.releasedAs.includes(release)) era.releasedAs.push(release);

    songs.push({
      id: makeId("r", eraCell, nameCell, row[8]),
      section: "released",
      status: "released",
      era: era.key,
      release,
      title: name.title,
      producers: name.producers,
      features: name.features,
      aliases: name.aliases,
      notes: clean(row[3]),
      length: clean(row[4]),
      releaseDate: clean(row[5]),
      type: clean(row[6]),
      streaming: clean(row[7]),
      links,
      linkNote: links.length ? "" : clean(row[8]),
      audio,
      sheet: sheetRowUrl(TABS.released.gid, index)
    });
  });

  // covers: Art tab first, then the hand-made cover-links.json
  const artCovers = coversFromArtTab(artRows);
  const manualCovers = readCoverLinks();
  const manualByKey = new Map(Object.entries(manualCovers).filter(([, url]) => url).map(([name, url]) => [looseKey(name), url]));

  eraOrder.forEach(era => {
    const keys = [era.name, ...era.aliases].map(looseKey);
    // the picture in the era's own header row on the tracker comes first (served through /cover)
    const sheetCover = keys.map(key => sheetCovers.get(key)).find(Boolean);
    era.sheetCover = sheetCover || null;
    // Discord attachment links expire, so they go last
    const manual = keys.map(key => manualByKey.get(key)).filter(Boolean);
    const art = keys.map(key => artCovers.get(key)).filter(Boolean);
    const expiring = url => /cdn\.discordapp\.com|media\.discordapp\.net/i.test(url);
    era.covers = [...new Set([
      ...(sheetCover ? [`/cover/${encodeURIComponent(era.key)}`] : []),
      ...manual.filter(url => !expiring(url)),
      ...art,
      ...keys.map(key => artCovers.get("any:" + key)).filter(Boolean),
      ...manual.filter(expiring)
    ])];
    era.cover = era.covers[0] || null;

    const own = songs.filter(song => song.era === era.key);
    era.counts = {
      total: own.length,
      unreleased: own.filter(song => song.status === "unreleased").length,
      released: own.filter(song => song.status === "released").length,
      unsurfaced: own.filter(song => song.status === "unsurfaced").length,
      playable: own.filter(song => song.audio).length
    };
    if (!era.year) {
      const years = own.map(song => yearOf(song.fileDate) || yearOf(song.releaseDate)).filter(Boolean);
      era.year = years.length ? Math.min(...years) : null;
    }
  });

  /*
    Eras that only appear on the Released tab ("2093 (P2)") were added at the
    end. Put each one right after the era it's a part of ("2093"), or failing
    that, after the last era from the same year or earlier.
  */
  const ordered = eraOrder.filter(era => !era.late);
  eraOrder.filter(era => era.late).forEach(era => {
    const key = looseKey(era.name);
    let at = -1;
    ordered.forEach((other, index) => {
      const base = looseKey(other.name);
      if (base && key.startsWith(base) && key !== base) at = index;
    });
    if (at < 0 && era.year) {
      ordered.forEach((other, index) => { if (other.year && other.year <= era.year) at = index; });
    }
    // after any other late eras already placed behind that same era
    while (at >= 0 && at + 1 < ordered.length && ordered[at + 1].late && looseKey(ordered[at + 1].name) < key) at++;
    ordered.splice(at < 0 ? ordered.length : at + 1, 0, era);
  });

  return { eras: ordered.filter(era => era.counts.total), songs };
}

/* ---------- era covers from the tracker itself ----------
   Ported from tracker-player. The tracker drops each era's cover INTO the
   era's header row as an in-cell image. No CSV shows those; only the sheet's
   HTML view does, as docs.google.com/sheets-images-rt URLs. Those can't be
   hotlinked from another site, so /cover/:era fetches them server-side. */

const HTML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

function decodeHtml(text) {
  return String(text || "").replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, code) => {
    const key = code.toLowerCase();
    if (HTML_ENTITIES[key]) return HTML_ENTITIES[key];
    if (key[0] === "#") {
      const number = key[1] === "x" ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
      if (Number.isFinite(number)) return String.fromCodePoint(number);
    }
    return whole;
  });
}

function cellText(html) {
  return decodeHtml(String(html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div)>/gi, "\n")
    .replace(/<[^>]*>/g, "")).replace(/ /g, " ").trim();
}

// a heading row can hold a wide logo and the square cover; the squarest one wins
function pickRowImage(rowHtml) {
  const found = [];
  const pattern = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
  let match;
  while ((match = pattern.exec(rowHtml))) found.push(decodeHtml(match[1]));
  if (found.length <= 1) return found[0] || "";
  const squareness = url => {
    const size = String(url).match(/=w(\d+)-h(\d+)/i);
    if (!size) return 1;
    const w = Number(size[1]);
    const h = Number(size[2]);
    return w && h ? Math.min(w, h) / Math.max(w, h) : 0;
  };
  let best = found[0];
  found.forEach(url => { if (squareness(url) > squareness(best) + 0.05) best = url; });
  return best;
}

function parseSheetHtml(html) {
  const table = String(html || "").match(/<table[\s\S]*?<\/table>/i);
  if (!table) return { rows: [], imageRows: [] };
  const rows = [];
  const imageRows = [];
  const rowPattern = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let row;
  while ((row = rowPattern.exec(table[0]))) {
    const cells = [];
    const cellPattern = /<t([dh])\b([^>]*)>([\s\S]*?)<\/t\1>/gi;
    let cell;
    while ((cell = cellPattern.exec(row[1]))) {
      if (cell[1].toLowerCase() === "h") continue; // Google's row-number gutter
      const span = cell[2].match(/\bcolspan\s*=\s*["']?(\d+)/i);
      const width = Math.min(span ? Number(span[1]) : 1, 50);
      cells.push(cellText(cell[3]));
      for (let i = 1; i < width; i++) cells.push("");
    }
    if (cells.length) {
      rows.push(cells);
      imageRows.push(pickRowImage(row[1]));
    }
  }
  return { rows, imageRows };
}

// "=w105-h104" is the thumbnail the cell shows; a plain width gets a proper cover
const atCoverSize = url => String(url || "").replace(/=[swh]\d+(-[hw]\d+)?(-[a-z0-9]+)*$/i, "") + "=w600";

// an era header names the era, then the other names it goes by in brackets
function eraNamesInCell(cell) {
  const lines = clean(cell).split("\n").map(line => line.trim()).filter(Boolean);
  if (!lines.length) return [];
  const names = [lines[0]];
  const trimmed = lines[0].replace(/\s*\(.*$/, "").trim();
  if (trimmed && trimmed !== lines[0]) names.push(trimmed);
  lines.forEach(line => {
    const inside = line.match(/^\((.+)\)$/);
    if (!inside) return;
    inside[1].split(",").forEach(alias => {
      const name = alias.trim();
      if (name && name.length <= 60 && !/^(prod|feat|with|collaboration)\b/i.test(name)) names.push(name);
    });
  });
  return names;
}

async function readSheetHtml(gid) {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/htmlview/sheet?headers=true&gid=${gid}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`sheet view ${response.status}`);
  return parseSheetHtml(await response.text());
}

function headerIndexes(rows) {
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const labels = rows[i].map(cell => cell.split("\n")[0].trim().toLowerCase());
    const name = labels.findIndex(label => label === "name");
    if (name >= 0) return { headerRow: i, name, era: labels.findIndex(label => /^(rec\. )?era$/.test(label)) };
  }
  return { headerRow: 0, name: 1, era: 0 };
}

const ERA_TALLY = /\d+\s*(og files?|total full|full|tagged|partial|snippets?|unavailable|(ep|mixtape|album) tracks|singles)/i;

// looseKey(era name) -> the Google image URL for that era's cover
async function readSheetImages() {
  const byEra = new Map();
  const underHeading = new Map();
  const add = (map, name, url) => {
    const key = looseKey(name);
    if (key && !map.has(key)) map.set(key, url);
  };

  // song tabs first: art in an era's own header row is the era's own cover
  for (const gid of [TABS.unreleased.gid, TABS.released.gid]) {
    const grid = await readSheetHtml(gid);
    const { headerRow, name, era } = headerIndexes(grid.rows);
    grid.rows.forEach((row, index) => {
      const image = grid.imageRows[index];
      if (!image || index <= headerRow) return;
      const at = atCoverSize(image);
      eraNamesInCell(row[name]).forEach(n => add(byEra, n, at));
      // the songs under a heading can file themselves under a different name
      if (era < 0) return;
      for (let next = index + 1; next < grid.rows.length && next <= index + 8; next++) {
        if (grid.imageRows[next]) break;
        const cell = clean(grid.rows[next][era]);
        if (!cell || ERA_TALLY.test(cell)) continue;
        eraNamesInCell(cell).forEach(n => add(underHeading, n, at));
        break;
      }
    });
  }
  underHeading.forEach((url, key) => { if (!byEra.has(key)) byEra.set(key, url); });
  const fromSongTabs = byEra.size;

  // then the Art tab, for eras the song tabs had no picture for
  try {
    const grid = await readSheetHtml(TABS.art.gid);
    const { headerRow, name, era } = headerIndexes(grid.rows);
    grid.rows.forEach((row, index) => {
      const image = grid.imageRows[index];
      if (!image || index <= headerRow) return;
      const at = atCoverSize(image);
      [...(era >= 0 ? eraNamesInCell(row[era]) : []), ...eraNamesInCell(row[name])].forEach(n => add(byEra, n, at));
    });
  } catch (err) {
    console.warn("[covers] art tab:", err.message);
  }

  console.log(`[covers] ${byEra.size} era names have art on the tracker (${fromSongTabs} from era headers)`);
  return byEra;
}

const sheetImageBytes = new Map(); // era key -> { at, type, body }

async function sheetCoverImage(era) {
  if (!era || !era.sheetCover) return null;
  const held = sheetImageBytes.get(era.key);
  if (held && Date.now() - held.at < 6 * 60 * 60 * 1000 && held.url === era.sheetCover) return held;

  // Google now and then refuses one of a burst of requests; one retry helps
  let response = await fetch(era.sheetCover, { signal: AbortSignal.timeout(20000) }).catch(() => null);
  if (!response || !response.ok) {
    await new Promise(resolve => setTimeout(resolve, 600));
    response = await fetch(era.sheetCover, { signal: AbortSignal.timeout(20000) }).catch(() => null);
  }
  const type = response && (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!response || !response.ok || !/^image\//.test(type)) return null;

  const image = { at: Date.now(), url: era.sheetCover, type, body: Buffer.from(await response.arrayBuffer()) };
  if (sheetImageBytes.size > 80) sheetImageBytes.clear();
  sheetImageBytes.set(era.key, image);
  return image;
}

/* ---------- the other tabs (Snippets, Lives, Videos, ...) ---------- */

function buildSection(key, rows, eraLookup) {
  const header = rows[0] || [];
  const labels = header.map(cell => clean(cell).split("\n")[0].trim());
  const linkCol = labels.findIndex(label => /^link/i.test(label));
  const nameCol = labels.findIndex(label => /^(name|song name|account)$/i.test(label));
  const eraCol = labels.findIndex(label => /^era$/i.test(label));
  const items = [];
  let currentEra = "";
  let currentGroup = "";

  rows.slice(1).forEach((row, offset) => {
    const index = offset + 1;
    const links = linkCol >= 0 ? extractLinks(row[linkCol]) : [];
    const eraCell = eraCol >= 0 ? clean(row[eraCol]) : "";
    const nameCell = nameCol >= 0 ? clean(row[nameCol]) : "";
    const filled = row.filter(cell => clean(cell)).length;

    // legend rows ("Unknown | Snippet | ...") and dividers
    if (!eraCell && !links.length) {
      if (filled && filled <= 2 && nameCell) {
        const heading = firstLine(nameCell);
        const era = eraLookup(heading);
        if (era) {
          currentEra = era.key;
          currentGroup = "";
        } else {
          currentGroup = heading;
        }
      }
      return;
    }
    if (!nameCell && !links.length) return;

    const era = eraLookup(eraCell);
    const name = parseNameCell(nameCell || "Untitled");
    const fields = [];

    row.forEach((cell, col) => {
      if (col === eraCol || col === nameCol || col === linkCol) return;
      const value = clean(cell);
      if (!value || value === "N/A") return;
      let label = labels[col];
      if (!label) label = DATE_LIKE.test(value) ? "Date" : "Info";
      if (/^notes/i.test(label)) label = "Notes";
      fields.push({ label, value });
    });

    items.push({
      id: makeId(key, eraCell, nameCell, row[linkCol]),
      section: key,
      era: era ? era.key : "",
      eraName: era ? era.name : eraCell,
      group: currentGroup,
      title: name.title,
      producers: name.producers,
      features: name.features,
      aliases: name.aliases,
      fields,
      links,
      linkNote: links.length || linkCol < 0 ? "" : clean(row[linkCol]),
      audio: pickAudio(links),
      sheet: sheetRowUrl(TABS[key].gid, index)
    });

    if (!era && eraCell === "" && currentEra) items[items.length - 1].era = currentEra;
  });

  return items;
}

/* ---------- cache ---------- */

let cache = null;
let loading = null;

async function load() {
  const started = Date.now();
  const rows = {};

  await Promise.all(Object.entries(TABS).map(async ([key, tab]) => {
    try {
      rows[key] = await fetchTab(tab.gid);
    } catch (err) {
      console.warn(`[sheet] ${key} failed:`, err.message);
      rows[key] = cache && cache.raw && cache.raw[key] ? cache.raw[key] : [];
    }
  }));

  let sheetCovers;
  try {
    sheetCovers = await readSheetImages();
  } catch (err) {
    console.warn("[covers] reading the tracker's pictures failed:", err.message);
    sheetCovers = cache && cache.sheetCovers ? cache.sheetCovers : new Map();
  }

  const { eras, songs } = buildSongs(rows.unreleased, rows.released, rows.art, sheetCovers);
  const eraByLoose = new Map();
  eras.forEach(era => [era.name, ...era.aliases].forEach(name => eraByLoose.set(looseKey(name), era)));
  const eraLookup = name => eraByLoose.get(looseKey(name)) || null;

  const sections = {};
  SECTION_KEYS.forEach(key => {
    sections[key] = buildSection(key, rows[key] || [], eraLookup);
  });

  const next = {
    raw: rows,
    sheetCovers,
    updatedAt: new Date().toISOString(),
    eras,
    songs,
    sections,
    json: {}
  };

  // pre-serialise so requests are just a buffer copy
  next.json.meta = JSON.stringify({
    updatedAt: next.updatedAt,
    sheetUrl: `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`,
    eras,
    tabs: [{ key: "songs", label: "Songs", count: songs.length }]
      .concat(SECTION_KEYS
        .sort((a, b) => TABS[a].order - TABS[b].order)
        .map(key => ({ key, label: TABS[key].label, count: sections[key].length })))
  });
  next.json.songs = JSON.stringify(songs);
  SECTION_KEYS.forEach(key => { next.json[key] = JSON.stringify(sections[key]); });

  cache = next;
  console.log(`[sheet] loaded ${songs.length} songs in ${eras.length} eras, ` +
    SECTION_KEYS.map(key => `${key} ${sections[key].length}`).join(", ") +
    ` (${Date.now() - started}ms)`);
}

function ensureLoaded() {
  if (cache) return Promise.resolve();
  if (!loading) loading = load().finally(() => { loading = null; });
  return loading;
}

function refresh() {
  if (loading) return;
  loading = load().catch(err => console.error("[sheet] refresh failed:", err)).finally(() => { loading = null; });
}

setInterval(refresh, REFRESH_MINUTES * 60 * 1000).unref();

/* ---------- web server ---------- */

const PUBLIC = path.join(__dirname, "public");
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon"
};
const gzCache = new Map();
const imgurCache = new Map();

function send(req, res, status, body, type, cacheSeconds = 0) {
  const headers = { "Content-Type": type };
  if (cacheSeconds) headers["Cache-Control"] = `public, max-age=${cacheSeconds}`;
  let data = Buffer.isBuffer(body) ? body : Buffer.from(String(body));

  if (data.length > 1024 && /gzip/.test(req.headers["accept-encoding"] || "") && !/image\/(png|x-icon)/.test(type)) {
    const key = typeof body === "string" ? body : null;
    let zipped = key && gzCache.get(key);
    if (!zipped) {
      zipped = zlib.gzipSync(data);
      if (key) {
        if (gzCache.size > 40) gzCache.clear();
        gzCache.set(key, zipped);
      }
    }
    data = zipped;
    headers["Content-Encoding"] = "gzip";
    headers["Vary"] = "Accept-Encoding";
  }
  headers["Content-Length"] = data.length;
  res.writeHead(status, headers);
  res.end(req.method === "HEAD" ? undefined : data);
}

const sendJson = (req, res, status, body) =>
  send(req, res, status, typeof body === "string" ? body : JSON.stringify(body), TYPES[".json"], status === 200 ? 120 : 0);

function sendFile(req, res, file) {
  fs.readFile(file, (err, data) => {
    if (err) return send(req, res, 404, "Not found", "text/plain; charset=utf-8");
    const ext = path.extname(file);
    send(req, res, 200, data, TYPES[ext] || "application/octet-stream", ext === ".html" ? 0 : 300);
  });
}


async function resolveImgur(id) {
  if (imgurCache.has(id)) return imgurCache.get(id);
  const page = await (await fetch(`https://imgur.gg/f/${id}`, { signal: AbortSignal.timeout(20000) })).text();
  const found = page.match(/<meta[^>]+property="og:(?:audio|video)"[^>]+content="([^"]+)"/i) ||
    page.match(new RegExp(`https://[a-z]\\.imgur\\.gg/${id}-[^"'\\s<>]+`));
  const direct = found ? (found[1] || found[0]) : null;
  if (direct) imgurCache.set(id, direct);
  return direct;
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

async function sourceUrl(song) {
  const id = pillowsId(song.links.find(link => pillowsId(link)) || "");
  if (id) return `https://api.pillows.su/api/download/${id}`;
  const imgId = imgurId(song.links.find(link => imgurId(link)) || "");
  if (imgId) return resolveImgur(imgId);
  return null;
}

async function fetchAudio(song) {
  const url = await sourceUrl(song);
  if (!url) throw new Error("no file link");
  const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const audio = Buffer.from(await response.arrayBuffer());
  if (!audio.length) throw new Error("empty file");
  return { audio, response, url };
}

// the era cover, fetched once and kept for tagging and the ZIP's cover file
const coverCache = new Map();

async function eraCover(era) {
  if (!era) return null;
  if (coverCache.has(era.key)) return coverCache.get(era.key);
  let found = null;
  for (const link of era.covers || []) {
    try {
      if (link.startsWith("/cover/")) {
        const image = await sheetCoverImage(era);
        if (image && /^image\/(jpeg|png)$/.test(image.type)) { found = { mime: image.type, image: image.body }; break; }
        continue;
      }
      const response = await fetch(link, { signal: AbortSignal.timeout(15000) });
      const mime = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (!response.ok || !/^image\/(jpeg|jpg|png)$/.test(mime)) continue;
      const image = Buffer.from(await response.arrayBuffer());
      if (!image.length || image.length > 8 * 1024 * 1024) continue;
      found = { mime: mime === "image/jpg" ? "image/jpeg" : mime, image };
      break;
    } catch { /* next one */ }
  }
  if (coverCache.size > 60) coverCache.clear();
  coverCache.set(era.key, found);
  return found;
}

// what goes into the file: same fields tracker-player writes, plus track number
function tagsFor(song, era, track) {
  const features = song.features.map(f => ` (${f})`).join("");
  return {
    title: cleanTitle(song.title) + features,
    artist: "Yeat",
    albumArtist: "Yeat",
    album: era ? era.name : (song.eraName || ""),
    year: era && era.year ? String(era.year) : "",
    genre: "Hip-Hop/Rap",
    comment: song.producers.length ? `prod. ${song.producers.join(", ")}` : "",
    track: track ? String(track) : ""
  };
}

function findItem(id) {
  return cache.songs.find(song => song.id === id) ||
    Object.values(cache.sections).flat().find(item => item.id === id) || null;
}

async function sendTaggedSong(req, res, id) {
  const song = findItem(id);
  if (!song || !song.audio) return send(req, res, 404, "That song has no file to download.", "text/plain; charset=utf-8");
  const era = cache.eras.find(e => e.key === song.era) || null;
  try {
    const { audio, response, url } = await fetchAudio(song);
    const result = tagAudio(audio, tagsFor(song, era), await eraCover(era));
    const ext = originalExt(response, url, result);
    const name = `${safeName(cleanTitle(song.title))}.${ext}`;
    console.log(`[download] ${song.title}: ${result.kind}, ${result.tagged ? "tagged" : "sent as-is"}`);
    res.writeHead(200, {
      "Content-Type": response.headers.get("content-type") || "application/octet-stream",
      "Content-Length": result.file.length,
      "Content-Disposition": `attachment; filename="${name.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      "Cache-Control": "no-store"
    });
    res.end(result.file);
  } catch (err) {
    console.warn(`[download] ${song.title}: ${err.message}`);
    send(req, res, 502, "Couldn't get that file from the host. Try again in a bit.", "text/plain; charset=utf-8");
  }
}

const SNIPPETISH = /^(snippet|partial|tagged|beat only)$/i;

async function sendEraZip(req, res, eraKey, params) {
  const era = cache.eras.find(e => e.key === eraKey);
  if (!era) return send(req, res, 404, "No such era.", "text/plain; charset=utf-8");

  const fullOnly = params.get("full") === "1";
  const which = params.get("which") || "all"; // all | unreleased | released
  let songs = cache.songs.filter(song => song.era === era.key && song.audio);
  if (which !== "all") songs = songs.filter(song => song.status === which);
  if (fullOnly) songs = songs.filter(song => !SNIPPETISH.test(song.available || ""));
  // a released song often points at the same file as its unreleased OG row
  const seenFiles = new Set();
  songs = songs.filter(song => !seenFiles.has(song.audio.src) && seenFiles.add(song.audio.src));
  if (!songs.length) return send(req, res, 404, "This era has no files to download with those settings.", "text/plain; charset=utf-8");

  const folder = safeName(`Yeat - ${era.name}`);
  const zipName = `${folder}.zip`;
  res.writeHead(200, {
    "Content-Type": "application/zip",
    "Content-Disposition": `attachment; filename="${zipName.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(zipName)}`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });

  const zip = new ZipStream(res);
  const used = new Set();
  const failed = [];
  const lines = [];
  const pad = String(songs.length).length;

  console.log(`[zip] ${era.name}: ${songs.length} files`);

  try {
    // cover first, so the folder has art (the same picture goes into every file's tags)
    const cover = await eraCover(era);
    if (cover) await zip.add(`${folder}/cover.${cover.mime === "image/png" ? "png" : "jpg"}`, once(cover.image));
    let tagged = 0;

    for (let i = 0; i < songs.length; i++) {
      const song = songs[i];
      const number = String(i + 1).padStart(pad, "0");
      const label = song.status === "released" ? "" : song.available && song.available !== "OG File" && song.available !== "Full" ? ` [${song.available}]` : "";
      try {
        const { audio, response, url } = await fetchAudio(song);
        if (zip.closed) throw new Error("client went away");
        const result = tagAudio(audio, tagsFor(song, era, i + 1), cover);
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
      `Yeat - ${era.name}`,
      era.year ? `Year: ${era.year}` : "",
      `Downloaded ${new Date().toLocaleString()} with archivedownloader`,
      "archivedownloader is a Yeat port of The Ultimate Uzi Archive (uziarchive.top) by @flexbymistake.",
      "Song data from the Yeat Trackër, edited by raglord, red., shock, Snarke and zamfir.",
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

async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  const route = decodeURIComponent(url.pathname);

  if (route === "/api/meta") {
    try {
      await ensureLoaded();
      return sendJson(req, res, 200, cache.json.meta);
    } catch (err) {
      console.error(err);
      return sendJson(req, res, 503, { error: "The tracker could not be loaded. Check your internet and try again in a minute." });
    }
  }

  let match = route.match(/^\/api\/tab\/([a-z]+)$/);
  if (match) {
    try {
      await ensureLoaded();
      const body = match[1] !== "meta" && cache.json[match[1]];
      return body ? sendJson(req, res, 200, body) : sendJson(req, res, 404, { error: "No such tab." });
    } catch (err) {
      console.error(err);
      return sendJson(req, res, 503, { error: "The tracker could not be loaded. Check your internet and try again in a minute." });
    }
  }

  match = route.match(/^\/imgur\/([A-Za-z0-9]{5,12})$/);
  if (match) {
    try {
      const direct = await resolveImgur(match[1]);
      if (!direct) return send(req, res, 404, "File not found on imgur.gg", "text/plain; charset=utf-8");
      res.writeHead(302, { Location: direct });
      return res.end();
    } catch (err) {
      console.error("[imgur]", err.message);
      return send(req, res, 502, "imgur.gg did not answer", "text/plain; charset=utf-8");
    }
  }

  match = route.match(/^\/cover\/([^/]+)$/);
  if (match) {
    try {
      await ensureLoaded();
      const era = cache.eras.find(e => e.key === match[1]);
      const image = await sheetCoverImage(era);
      if (!image) return send(req, res, 404, "No cover", "text/plain; charset=utf-8");
      res.writeHead(200, { "Content-Type": image.type, "Content-Length": image.body.length, "Cache-Control": "public, max-age=86400" });
      return res.end(req.method === "HEAD" ? undefined : image.body);
    } catch (err) {
      console.warn("[covers]", err.message);
      return send(req, res, 502, "Couldn't fetch that cover", "text/plain; charset=utf-8");
    }
  }

  match = route.match(/^\/download\/([A-Za-z0-9_-]{6,16})$/);
  if (match) {
    if (busy.songs >= MAX_SONG_DOWNLOADS) return send(req, res, 429, "Lots of downloads running right now. Try again in a minute.", "text/plain; charset=utf-8");
    try {
      await ensureLoaded();
    } catch {
      return send(req, res, 503, "The tracker could not be loaded.", "text/plain; charset=utf-8");
    }
    busy.songs++;
    try {
      return await sendTaggedSong(req, res, match[1]);
    } finally {
      busy.songs--;
    }
  }

  match = route.match(/^\/zip\/era\/([^/]+)$/);
  if (match) {
    const who = clientIp(req);
    if (busy.zips >= MAX_ZIPS || busy.zipIps.has(who)) {
      return send(req, res, 429, busy.zipIps.has(who)
        ? "You already have an era ZIP downloading. Wait for it to finish, then start the next one."
        : "Other people are downloading era ZIPs right now. Try again in a few minutes.", "text/plain; charset=utf-8");
    }
    try {
      await ensureLoaded();
    } catch {
      return send(req, res, 503, "The tracker could not be loaded.", "text/plain; charset=utf-8");
    }
    busy.zips++;
    busy.zipIps.add(who);
    try {
      return await sendEraZip(req, res, match[1], url.searchParams);
    } finally {
      busy.zips--;
      busy.zipIps.delete(who);
    }
  }

  // real files in /public
  const file = path.normalize(path.join(PUBLIC, route));
  if (file.startsWith(PUBLIC + path.sep) && path.extname(file) && fs.existsSync(file)) {
    return sendFile(req, res, file);
  }

  // /, /era/..., /song/..., /tab/... are all drawn by the page itself
  if (route === "/" || route === "/credits" || /^\/(era|song|tab)\//.test(route)) {
    return sendFile(req, res, path.join(PUBLIC, "index.html"));
  }

  send(req, res, 404, "Not found", "text/plain; charset=utf-8");
}

const busy = { zips: 0, zipIps: new Set(), songs: 0 };

// behind Caddy the visitor's address is in X-Forwarded-For
function clientIp(req) {
  const forwarded = PUBLIC_MODE && String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || req.socket.remoteAddress || "?";
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
      if (!res.headersSent) send(req, res, 500, "Something broke", "text/plain; charset=utf-8");
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
    ensureLoaded().catch(err => console.error("[sheet] first load failed:", err.message));
  });
}

listen(PORT);
