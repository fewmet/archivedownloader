/*
  tracker.js - reads any artist tracker and turns it into eras, songs and tabs.

  Almost every tracker is a Google Sheet copied from the same "Ye Tracker"
  template, but the columns move around between them (Yeat has 12, Lil Peep
  has 7, XXXTENTACION calls its links "Download(s)"). So nothing here uses
  column letters: every tab's header row is read and the columns are found by
  name.

  Everything comes from the sheet's published HTML view (/htmlview), not the
  CSV export, because:
    - it still works on trackers that turned off downloading (Uzi, Ken Carson,
      Juice WRLD, OsamaSon and others block the CSV export)
    - it keeps hyperlinks, so a cell that just says "Link" still gives the URL
    - it shows the pictures pasted into cells, which is where era covers live
  A few trackers run their own site that serves that same HTML (tylertracker.net);
  those work the same way.
*/

const crypto = require("crypto");

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

function yearOf(value) {
  const match = clean(value).match(/\b(19|20)\d{2}\b/);
  return match ? Number(match[0]) : null;
}

const DATE_LIKE = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}$|^\d{4}$|^(early|mid|late)\s+\d{4}$|^\?{2,}/i;

/* ---------- where a tracker lives ---------- */

const SHEET_ID = /^[A-Za-z0-9_-]{25,80}$/;

// trackers that are their own website, serving Google's HTML view of the sheet
const MIRROR_SITES = ["tylertracker.net", "asaprockytracker.net", "deftonestracker.net"];

function sourceUrls(source) {
  if (source.site) {
    const base = `https://${source.site}`;
    return {
      list: `${base}/`,
      tab: gid => `${base}/preview/sheet/${gid}.html`,
      edit: (gid, row) => `${base}/#gid=${gid}`,
      open: `${base}/`
    };
  }
  const base = `https://docs.google.com/spreadsheets/d/${source.sheetId}`;
  return {
    list: `${base}/htmlview`,
    tab: gid => `${base}/htmlview/sheet?headers=true&gid=${gid}`,
    edit: (gid, row) => `${base}/edit?gid=${gid}#gid=${gid}${row != null ? `&range=A${row + 1}` : ""}`,
    open: `${base}/edit`
  };
}

/*
  Turns whatever someone pasted into a tracker source:
    https://docs.google.com/spreadsheets/d/<id>/edit?gid=123#gid=123
    https://docs.google.com/spreadsheets/u/1/d/<id>/htmlview
    <id> on its own
    https://tylertracker.net/
*/
function parseTrackerLink(input) {
  const text = clean(input);
  if (!text) return null;

  const sheet = text.match(/docs\.google\.com\/spreadsheets\/(?:u\/\d+\/)?d\/(?:e\/)?([A-Za-z0-9_-]{25,80})/i);
  if (sheet) return { sheetId: sheet[1] };
  if (SHEET_ID.test(text)) return { sheetId: text };

  try {
    const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (MIRROR_SITES.includes(host)) return { site: host };
  } catch { /* not a URL */ }
  return null;
}

function sourceKey(source) {
  return source.site ? `site-${source.site}` : `sheet-${source.sheetId}`;
}

function sourceFromKey(key) {
  const sheet = String(key).match(/^sheet-([A-Za-z0-9_-]{25,80})$/);
  if (sheet) return { sheetId: sheet[1] };
  const site = String(key).match(/^site-([a-z0-9.-]+)$/);
  if (site && MIRROR_SITES.includes(site[1])) return { site: site[1] };
  return null;
}

/* ---------- fetching ---------- */

const MAX_TAB_BYTES = 40 * 1024 * 1024;

async function fetchText(url, timeout = 60000) {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(timeout),
    headers: { "User-Agent": "Mozilla/5.0 (archivedownloader)" }
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const length = Number(response.headers.get("content-length") || 0);
  if (length > MAX_TAB_BYTES) throw new Error("tab is too big");
  const text = await response.text();
  if (text.length > MAX_TAB_BYTES) throw new Error("tab is too big");
  return text;
}

/* ---------- reading Google's HTML view ---------- */

const HTML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", "#160": " " };

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
    .replace(/<[^>]*>/g, ""))
    .replace(/ /g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

// Google wraps every link: https://www.google.com/url?q=<real>&sa=D&...
function unwrapLink(href) {
  const url = decodeHtml(href);
  const wrapped = url.match(/^https?:\/\/(?:www\.)?google\.com\/url\?q=([^&]+)/i);
  if (wrapped) {
    try { return decodeURIComponent(wrapped[1]); } catch { return wrapped[1]; }
  }
  return url;
}

function linksIn(text, html) {
  const found = [];
  const add = link => {
    const tidy = String(link).trim().replace(/[),.]+$/, "");
    if (/^https?:\/\//i.test(tidy) && !found.includes(tidy)) found.push(tidy);
  };
  (String(html || "").match(/<a\b[^>]*\bhref\s*=\s*["'][^"']+["']/gi) || [])
    .forEach(tag => add(unwrapLink(tag.match(/href\s*=\s*["']([^"']+)["']/i)[1])));
  (String(text || "").match(/https?:\/\/[^\s"<>]+/g) || []).forEach(add);
  return found;
}

// a heading row can hold a wide logo and the square cover; the squarest one wins
function pickRowImage(images) {
  if (images.length <= 1) return images[0] || "";
  const squareness = url => {
    const size = String(url).match(/=w(\d+)-h(\d+)/i);
    if (!size) return 1;
    const w = Number(size[1]);
    const h = Number(size[2]);
    return w && h ? Math.min(w, h) / Math.max(w, h) : 0;
  };
  let best = images[0];
  images.forEach(url => { if (squareness(url) > squareness(best) + 0.05) best = url; });
  return best;
}

/*
  One tab -> rows of { cells: [text], links: [[url]], image }.
  Merged cells (colspan) are padded out so columns stay lined up.
*/
function parseSheetHtml(html) {
  const tableStart = html.search(/<table\b/i);
  if (tableStart < 0) return [];
  const tableEnd = html.lastIndexOf("</table>");
  const table = html.slice(tableStart, tableEnd > tableStart ? tableEnd : undefined);

  const rows = [];
  const rowPattern = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let row;
  while ((row = rowPattern.exec(table))) {
    const cells = [];
    const links = [];
    const images = [];
    const cellPattern = /<t([dh])\b([^>]*)>([\s\S]*?)<\/t\1>/gi;
    let cell;
    while ((cell = cellPattern.exec(row[1]))) {
      if (cell[1].toLowerCase() === "h") continue; // Google's row-number gutter
      const span = cell[2].match(/\bcolspan\s*=\s*["']?(\d+)/i);
      const width = Math.min(span ? Number(span[1]) : 1, 50);
      const text = cellText(cell[3]);
      cells.push(text);
      links.push(linksIn(text, cell[3]));
      const imagePattern = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
      let image;
      while ((image = imagePattern.exec(cell[3]))) images.push(decodeHtml(image[1]));
      for (let i = 1; i < width; i++) { cells.push(""); links.push([]); }
    }
    if (cells.length) rows.push({ cells, links, image: pickRowImage(images) });
  }
  return rows;
}

// the tab list is in the page's script: {name: "💿 Unreleased", ... gid: "123"}
function parseTabList(html) {
  const tabs = [];
  const pattern = /\{name:\s*"((?:[^"\\]|\\.)*)"(?:,\s*pageUrl:\s*"((?:[^"\\]|\\.)*)")?[^{}]*?gid:\s*"(\d+)"/g;
  let match;
  while ((match = pattern.exec(html))) {
    const gid = match[3];
    const pageUrl = (match[2] || "").replace(/\\x([0-9a-f]{2})/gi, (w, hex) => String.fromCharCode(parseInt(hex, 16))).replace(/\\\//g, "/");
    let name = match[1]
      .replace(/\\x([0-9a-f]{2})/gi, (w, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\\u([0-9a-f]{4})/gi, (w, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\\\//g, "/")
      .replace(/\\(.)/g, "$1");
    name = decodeHtml(name).trim();
    if (!tabs.some(tab => tab.gid === gid)) tabs.push({ name, gid, pageUrl });
  }
  const title = decodeHtml((html.match(/<title>([^<]*)/i) || [])[1] || "").replace(/\s*-\s*Google (Drive|Sheets)\s*$/i, "").trim();
  return { title, tabs };
}

/*
  Which tabs belong on the site. Only tabs that are songs or files people can
  play or look through make it in. Everything else a tracker keeps (Recent,
  Best Of, Grails, Wanted, Worst Of are just filtered copies of Unreleased;
  Tracklists, Key, Fakes, Groupbuys, Socials, Album Copies, Template and so on
  aren't songs) is left out on purpose.
*/
const TAB_RULES = [
  ["unreleased", /^unreleased\b/],
  ["released", /^released\b/],
  ["art", /^(cover )?art\b|^art ?\/ ?images/],
  ["snippets", /snippets/],
  ["stems", /^stems|sessions (&|and) stems|^misc \+ stems|stems ?\/ ?sessions/],
  ["lives", /^(instagram|ig) lives|^lives\b/],
  ["videos", /^(music )?videos\b/],
  ["performances", /performances/],
  ["samples", /^samples\b/],
  ["extras", /^misc\b/]
];

const SKIP_TAB = /redirect|template|test sheet|\bold format\b/;

function bareTabName(name) {
  return clean(name)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 &/+().\[\]-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function pickTabs(tabs) {
  const picked = {};
  tabs.forEach(tab => {
    const bare = bareTabName(tab.name);
    if (!bare || SKIP_TAB.test(bare)) return;
    // "Best Of (Unreleased)" is a filtered copy, not the Unreleased tab
    if (/best of|special|grails|wanted|worst of|recent|highlights|notable|og files|unheard|leaked|fully/.test(bare) &&
        !/^(unreleased|released)\b/.test(bare)) return;
    for (const [key, rule] of TAB_RULES) {
      if (rule.test(bare)) {
        if (!picked[key]) picked[key] = tab;
        break;
      }
    }
  });
  return picked;
}

/* ---------- headers ---------- */

function headerLabel(cell) {
  return firstLine(cell)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ()./?&-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const NAME_HEADER = /^(song name|name|title|track name|track|song|account)$/;

function findHeaderRow(rows) {
  for (let i = 0; i < Math.min(rows.length, 12); i++) {
    const labels = rows[i].cells.map(headerLabel);
    if (labels.some(label => NAME_HEADER.test(label) || /^name\b/.test(label)) &&
        labels.filter(Boolean).length >= 3) return i;
  }
  return -1;
}

/*
  Column positions by header name. The patterns cover the spellings used by
  the trackers in the list ("Available Length" / "Portion" / "Availability" /
  "Currently Available", "Link(s)" / "Links" / "Main Links" / "Source" /
  "Download(s)", and so on).
*/
function mapColumns(headerCells) {
  const labels = headerCells.map(headerLabel);
  const used = new Set();
  const find = (pattern, { last = false } = {}) => {
    const order = labels.map((label, index) => index);
    if (last) order.reverse();
    for (const index of order) {
      if (!used.has(index) && pattern.test(labels[index])) {
        used.add(index);
        return index;
      }
    }
    return -1;
  };

  const cols = {};
  cols.era = find(/^(rec\.? ?era|recording era|era|album)$/);
  cols.relEra = find(/^(rel\.? ?era|release era)$/);
  // Uzi's Released tab heads its first two columns "Recording" and "Release"
  if (cols.era < 0 && /^recording$/.test(labels[0] || "") && /^release$/.test(labels[1] || "")) {
    cols.era = 0; used.add(0);
    if (cols.relEra < 0) { cols.relEra = 1; used.add(1); }
  }
  // a blank first header over a column of era names (Summrs' Released tab)
  if (cols.era < 0 && !labels[0] && cols.relEra === 1) { cols.era = 0; used.add(0); }
  cols.name = find(/^(song name|name|title|track name|song|account)$/) ;
  if (cols.name < 0) cols.name = find(/^name\b/);
  if (cols.name < 0) cols.name = find(/^track$/);
  cols.notes = find(/^(notes|info|notes &|description)/);
  cols.length = find(/^(track length|length|track|full length|duration)$/);
  cols.preview = find(/first preview|surface/);
  cols.ogLeak = find(/og file leak/);
  cols.leak = find(/^leak( date)?$/);
  cols.file = find(/^(file|file date|file \/ aprox date|date of recording|recording|recorded|recording date)$/);
  cols.date = find(/^(release|release date|date|released)$/);
  cols.type = find(/^(type|file type|track type)$/);
  cols.available = find(/^(available length|available type|available|availability|availablitity|portion|currently availabl|status|song status|in circulation)/);
  cols.quality = find(/^quality/);
  cols.streaming = find(/^(streaming|on streaming\??|currently on dsps\??|streaming\?)$/);
  cols.links = labels
    .map((label, index) => (/^(link|links|link\(s\)|main link|main links|download|source|alternate link|og link)|(^|\s)(links?|link\(s\)|downloads?|download\(s\))$/.test(label) &&
      !used.has(index) ? index : -1))
    .filter(index => index >= 0);

  // a notes column whose header is a banner ("THIS TRACKER IS A ...") still sits right after Name
  if (cols.notes < 0 && cols.name >= 0 && !used.has(cols.name + 1) && labels[cols.name + 1] &&
      !cols.links.includes(cols.name + 1)) {
    cols.notes = cols.name + 1;
    used.add(cols.notes);
  }
  cols.labels = headerCells.map(cell => firstLine(cell));
  return cols;
}

const get = (row, index) => (index >= 0 ? clean(row.cells[index]) : "");

function rowLinks(row, cols) {
  if (cols.links.length) {
    const found = [];
    cols.links.forEach(index => (row.links[index] || []).forEach(link => !found.includes(link) && found.push(link)));
    return found;
  }
  return row.links.flat();
}

/* ---------- names ---------- */

/*
  The name cell looks like:
    BAND$
    (feat. Comethazine) (prod. ReeseyGotIt)
    (Band$, Bands)
*/
function parseNameCell(cell) {
  const lines = clean(cell).split("\n").map(line => line.trim()).filter(Boolean);
  let title = lines[0] || "";
  const producers = [];
  const features = [];
  const aliases = [];

  // some trackers write the credits on the title line: "Title (feat. X) (prod. Y)"
  const inline = title.match(/^(.*?)\s*((?:\((?:feat|ft|prod|with|ref)\.?[^()]*\)\s*)+)$/i);
  const rest = lines.slice(1);
  if (inline && inline[1]) {
    title = inline[1].trim();
    rest.unshift(inline[2]);
  }

  rest.forEach(line => {
    const groups = line.match(/\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g);
    if (!groups) return;
    groups.forEach(group => {
      const inner = group.slice(1, -1).trim();
      const lower = inner.toLowerCase();
      if (/^prod\.?\s/.test(lower)) producers.push(inner.replace(/^prod\.?\s*(by\s*)?/i, ""));
      else if (/^(feat\.?|ft\.?|with|ref\.?)\s/.test(lower)) features.push(inner);
      else inner.split(/,\s*/).forEach(alias => alias && aliases.push(alias));
    });
  });

  return { title, producers, features, aliases };
}

/* ---------- playable files ---------- */

const pillowsId = link => (String(link).match(/pillows(?:case)?\.su\/(?:f|api\/(?:get|download))\/([a-f0-9]{16,})/i) || [])[1] || null;
const imgurGgId = link => (String(link).match(/imgur\.gg\/(?:f\/)?([A-Za-z0-9]{5,12})(?:[-.\/?#]|$)/) || [])[1] || null;
const pixeldrainId = link => (String(link).match(/pixeldrain\.com\/(?:u|api\/file)\/([A-Za-z0-9]{5,20})/i) || [])[1] || null;
// the newer pixeldrain "/d/" links point into its filesystem, served from /api/filesystem
const pixeldrainFsId = link => (String(link).match(/pixeldrain\.com\/(?:d|api\/filesystem)\/([A-Za-z0-9]{5,20})(?:[/?#]|$)/i) || [])[1] || null;
const exoshareId = link => (String(link).match(/exoshare\.org\/(?:share|s)\/([A-Za-z0-9_-]{6,40})/i) || [])[1] || null;
const catboxFile = link => (String(link).match(/^https:\/\/files\.catbox\.moe\/[a-z0-9]+\.(mp3|m4a|wav|flac|ogg|opus|aac|mp4)$/i) || [])[0] || null;

function driveId(link) {
  const text = String(link);
  if (!/drive\.google\.com|drive\.usercontent\.google\.com/i.test(text)) return null;
  if (/\/drive\/folders\/|\/(spreadsheets|document|presentation|forms)\//i.test(text)) return null;
  const match = text.match(/\/file\/d\/([A-Za-z0-9_-]{10,})/i) || text.match(/[?&]id=([A-Za-z0-9_-]{10,})/i);
  return match ? match[1] : null;
}

const IMAGE_FILE = /\.(png|jpe?g|gif|webp|avif)(\?|$)/i;

/*
  The first link that is a file the browser can play. Every source is the
  original upload; nothing is re-encoded.
    pillows.su     api.pillows.su/api/download/<id>   (CORS + seeking)
    pixeldrain     pixeldrain.com/api/file/<id>       (CORS + seeking)
    catbox         the file itself
    imgur.gg       /imgur/<id>   - looked up once, then redirected
    exoshare       /exo/<id>     - looked up once, then redirected
    Google Drive   /drive/<id>   - redirected to the download address
*/
function pickAudio(links) {
  for (const link of links) {
    const id = pillowsId(link);
    if (id) return { src: `https://api.pillows.su/api/download/${id}`, host: "pillows", page: `https://pillows.su/f/${id}` };
  }
  for (const link of links) {
    const id = pixeldrainId(link);
    if (id) return { src: `https://pixeldrain.com/api/file/${id}`, host: "pixeldrain", page: `https://pixeldrain.com/u/${id}` };
  }
  for (const link of links) {
    const id = pixeldrainFsId(link);
    if (id) return { src: `https://pixeldrain.com/api/filesystem/${id}`, host: "pixeldrain", page: `https://pixeldrain.com/d/${id}` };
  }
  for (const link of links) {
    const file = catboxFile(link);
    if (file) return { src: file, host: "catbox", page: file };
  }
  for (const link of links) {
    const id = imgurGgId(link);
    if (id && !IMAGE_FILE.test(link)) return { src: `/imgur/${id}`, host: "imgur", page: `https://imgur.gg/f/${id}` };
  }
  for (const link of links) {
    const id = exoshareId(link);
    if (id) return { src: `/exo/${id}`, host: "exoshare", page: `https://exoshare.org/share/${id}` };
  }
  for (const link of links) {
    const id = driveId(link);
    if (id) return { src: `/drive/${id}`, host: "drive", page: `https://drive.google.com/file/d/${id}/view` };
  }
  return null;
}

/* ---------- eras ---------- */

// broken formulas and placeholders that show up where an era name should be
const BAD_ERA = /^(#(ref|n\/a|value|error|name|div\/0)!?|0|-|n\/a|\?+)$/i;

// "84 Total Full / 77 OG Files ..." or "7 Mixtape Tracks / 1 Singles ..."
const TALLY = /\d+\s*(total\b|total full|og files?|full\b|tagged|partial|snippets?|unavailable|((ep|mixtape|album|lp) )?tracks?\b|singles|features|throwaways|songs?\b|leaked|unleaked|streaming\b)/i;

// the era's name: in the Name column, or wherever the heading row put it
function headingText(row, cols) {
  const name = get(row, cols.name);
  if (name) return name;
  for (let i = 0; i < Math.min(row.cells.length, 4); i++) {
    if (i === cols.notes) continue;
    const text = clean(row.cells[i]);
    if (text && !TALLY.test(text) && !/^\(/.test(text)) return text;
  }
  return "";
}

function eraHeaderInfo(row, cols) {
  const nameCell = headingText(row, cols);
  const lines = nameCell.split("\n").map(line => line.trim()).filter(Boolean);
  const aliases = [];
  let label = "";
  let year = null;

  lines.slice(1).forEach(line => {
    if (line.includes("℗") || /^\(?©/.test(line)) {
      year = yearOf(line);
      label = line.replace(/^.*?[℗©]\s*(\d{4})?\s*/, "").trim();
    } else if (/^\(.*\)$/.test(line)) {
      line.replace(/^\(|\)$/g, "").split(/,\s*/).forEach(alias => {
        if (alias && alias.length <= 60 && !/^(prod|feat|with|collaboration)\b/i.test(alias)) aliases.push(alias);
      });
    }
  });

  // the longest piece of prose in the row is the era write-up
  let description = "";
  row.cells.forEach((cell, index) => {
    if (index === cols.name || index === cols.notes || index === cols.era) return;
    const text = clean(cell);
    if (text.length > 80 && text.length > description.length && !/^https?:\/\//.test(text)) description = text;
  });

  return {
    name: lines[0] || "",
    aliases,
    year,
    label,
    timeline: get(row, cols.notes).split("\n").map(line => line.trim()).filter(line => /^\(/.test(line)),
    description
  };
}

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

// "=w105-h104" is the thumbnail the cell shows; a plain width gets a proper cover
const atCoverSize = url => String(url || "").replace(/=[swh]\d+(-[hw]\d+)?(-[a-z0-9]+)*$/i, "") + "=w600";

/*
  A row is an era heading when it isn't a song: no file link, and either the
  era column holds the tally formula, the name carries a "℗ year" line, the
  row has the era's picture, or it's a filled-in banner row.
*/
function classifyRow(row, cols) {
  const eraCell = get(row, cols.era);
  const nameCell = get(row, cols.name);
  const links = rowLinks(row, cols);
  const audio = pickAudio(links);
  const filled = row.cells.filter(cell => clean(cell)).length;

  if (!nameCell && !eraCell) {
    if (!filled) return "empty";
    return headingText(row, cols) && (row.image || filled >= 2) ? "era" : "junk";
  }
  if (!nameCell && !links.length) return "junk";

  const tally = TALLY.test(eraCell) || TALLY.test(get(row, 0));
  const pressed = /℗|©\s*\d{4}/.test(nameCell);
  if (!audio && (tally || pressed || (row.image && !eraCell))) return "era";
  if (!eraCell && !audio && nameCell && cols.era >= 0) {
    // a heading with a timeline ("(May 30, 1996) (...)") or a write-up is an era
    const timeline = /^\(/.test(get(row, cols.notes));
    const writeUp = row.cells.some((cell, index) => index !== cols.notes && clean(cell).length > 120);
    if (!links.length && (timeline || writeUp)) return "era";
    if (filled <= 2 && !links.length) return "session";
  }
  return "song";
}

/* ---------- building an artist's data ---------- */

function buildSongs({ artistKey, unreleased, released, art, editUrl, manualCovers }) {
  const eras = new Map();
  const eraOrder = [];
  const songs = [];
  const headerImages = new Map(); // looseKey -> google image url
  let creatingLate = false;

  // a heading names its own era (exact); a song row may use one of the era's other names
  function eraFor(name, { exact = false } = {}) {
    const key = looseKey(firstLine(name));
    if (!key) return null;
    if (eras.has(key)) return eras.get(key);
    if (!exact) {
      for (const era of eraOrder) {
        if (era.aliases.some(alias => looseKey(alias) === key)) return era;
      }
    }
    let slug = slugify(name);
    while (eraOrder.some(era => era.key === slug)) slug += "-2";
    const era = {
      key: slug, name: firstLine(name), aliases: [], year: null, label: "",
      timeline: [], description: "", releasedAs: [], late: creatingLate
    };
    eras.set(key, era);
    eraOrder.push(era);
    return era;
  }

  const addImage = (name, url) => {
    const key = looseKey(name);
    if (key && url && !headerImages.has(key)) headerImages.set(key, atCoverSize(url));
  };

  function readSongTab(tab, section) {
    if (!tab || !tab.rows.length) return;
    const headerRow = findHeaderRow(tab.rows);
    if (headerRow < 0) return;
    const cols = mapColumns(tab.rows[headerRow].cells);
    if (cols.name < 0) return;

    let currentEra = null;
    let session = "";
    let pendingImage = "";

    tab.rows.forEach((row, index) => {
      if (index <= headerRow) return;
      const kind = classifyRow(row, cols);
      if (kind === "empty" || kind === "junk") return;

      if (kind === "era") {
        const info = eraHeaderInfo(row, cols);
        if (!info.name || BAD_ERA.test(info.name)) return;
        const era = eraFor(info.name, { exact: true });
        if (!era) return;
        info.aliases.forEach(alias => !era.aliases.includes(alias) && era.aliases.push(alias));
        if (info.year && !era.year) era.year = info.year;
        if (info.label && !era.label) era.label = info.label;
        if (info.timeline.length && !era.timeline.length) era.timeline = info.timeline;
        if (info.description && !era.description) era.description = info.description;
        if (row.image) {
          eraNamesInCell(headingText(row, cols)).forEach(name => addImage(name, row.image));
          pendingImage = row.image;
        } else {
          pendingImage = "";
        }
        currentEra = era;
        session = "";
        return;
      }

      if (kind === "session") {
        session = firstLine(get(row, cols.name));
        return;
      }

      const eraCell = get(row, cols.era);
      const era = (eraCell && !TALLY.test(eraCell) && !BAD_ERA.test(firstLine(eraCell)) ? eraFor(eraCell) : null) || currentEra;
      if (!era) return;
      // songs under a picture-only heading still file under their own era name
      if (pendingImage && eraCell) {
        eraNamesInCell(eraCell).forEach(name => addImage(name, pendingImage));
        pendingImage = "";
      }

      const nameCell = get(row, cols.name);
      const name = parseNameCell(nameCell);
      if (!name.title) return;
      const links = rowLinks(row, cols);
      const audio = pickAudio(links);
      const linkCellText = cols.links.map(i => get(row, i)).filter(Boolean).join("\n");

      const song = {
        id: makeId(artistKey, section, eraCell, nameCell, links.join(" "), index),
        section,
        era: era.key,
        session,
        title: name.title,
        producers: name.producers,
        features: name.features,
        aliases: name.aliases,
        notes: get(row, cols.notes),
        length: get(row, cols.length),
        type: get(row, cols.type),
        available: get(row, cols.available),
        quality: get(row, cols.quality),
        links,
        linkNote: links.length ? "" : linkCellText.slice(0, 120),
        audio,
        sheet: editUrl(tab.gid, index)
      };

      if (section === "released") {
        const release = get(row, cols.relEra);
        song.status = "released";
        song.release = release;
        song.releaseDate = get(row, cols.date) || get(row, cols.file);
        song.streaming = get(row, cols.streaming);
        if (release && !era.releasedAs.includes(release)) era.releasedAs.push(release);
      } else {
        song.status = audio ? "unreleased" : "unsurfaced";
        song.fileDate = get(row, cols.file);
        song.previewDate = get(row, cols.preview);
        song.leakDate = get(row, cols.leak) || (cols.leak < 0 ? get(row, cols.date) : "");
        song.ogLeakDate = get(row, cols.ogLeak);
      }
      songs.push(song);
    });
  }

  readSongTab(unreleased, "unreleased");
  creatingLate = true;
  readSongTab(released, "released");

  // covers from the Art tab: pictures in cells, and direct image links
  const artLinks = new Map();
  if (art && art.rows.length) {
    const headerRow = findHeaderRow(art.rows);
    const cols = headerRow >= 0 ? mapColumns(art.rows[headerRow].cells) : { era: 0, name: 1, links: [], labels: [] };
    const typeCol = cols.labels ? cols.labels.findIndex(label => /^(project type|type|art type)$/i.test(clean(label))) : -1;
    art.rows.forEach((row, index) => {
      if (index <= headerRow) return;
      const eraCell = get(row, cols.era);
      const nameCell = get(row, cols.name);
      const names = [...eraNamesInCell(eraCell), ...eraNamesInCell(nameCell)];
      if (row.image) names.forEach(name => addImage(name, row.image));
      const type = typeCol >= 0 ? get(row, typeCol).toLowerCase() : "";
      if (/back|insert|alt|poster|merch|tour/.test(type)) return;
      const link = row.links.flat().find(url => IMAGE_FILE.test(url) || /i\.ibb\.co|sndcdn\.com|mzstatic\.com|i\.scdn\.co|i\.imgur\.com/.test(url));
      if (!link || !eraCell) return;
      const eraKey = looseKey(firstLine(eraCell));
      // the art named after the era itself is the era's cover
      if (looseKey(firstLine(nameCell)) === eraKey) artLinks.set(`own:${eraKey}`, link);
      if (!artLinks.has(eraKey)) artLinks.set(eraKey, link);
    });
  }

  const manual = new Map(Object.entries(manualCovers || {})
    .filter(([, url]) => typeof url === "string" && /^https?:\/\//.test(url))
    .map(([name, url]) => [looseKey(name), url]));
  const expiring = url => /cdn\.discordapp\.com|media\.discordapp\.net/i.test(url);

  eraOrder.forEach(era => {
    const keys = [era.name, ...era.aliases].map(looseKey);
    const sheetImage = keys.map(key => headerImages.get(key)).find(Boolean) || null;
    const manualLinks = keys.map(key => manual.get(key)).filter(Boolean);
    era.sheetCover = sheetImage;
    era.covers = [...new Set([
      ...(sheetImage ? [`/cover/${artistKey}/${encodeURIComponent(era.key)}`] : []),
      ...manualLinks.filter(url => !expiring(url)),
      ...keys.map(key => artLinks.get(`own:${key}`)).filter(Boolean),
      ...keys.map(key => artLinks.get(key)).filter(Boolean),
      ...manualLinks.filter(expiring)
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
      const years = own.map(song => yearOf(song.fileDate) || yearOf(song.releaseDate) || yearOf(song.leakDate)).filter(Boolean);
      era.year = years.length ? Math.min(...years) : null;
    }
  });

  /*
    Eras that only show up on the Released tab ("2093 (P2)") get put right
    after the era they're part of ("2093"), or failing that after the last
    era from the same year or earlier.
  */
  const ordered = eraOrder.filter(era => !era.late);
  eraOrder.filter(era => era.late).forEach(era => {
    const key = looseKey(era.name);
    let at = -1;
    ordered.forEach((other, index) => {
      const base = looseKey(other.name);
      if (base && key.startsWith(base) && key !== base) at = index;
    });
    if (at < 0 && era.year) ordered.forEach((other, index) => { if (other.year && other.year <= era.year) at = index; });
    while (at >= 0 && at + 1 < ordered.length && ordered[at + 1].late && looseKey(ordered[at + 1].name) < key) at++;
    ordered.splice(at < 0 ? ordered.length : at + 1, 0, era);
  });

  ordered.forEach(era => { delete era.late; });
  return { eras: ordered.filter(era => era.counts.total), songs };
}

/* ---------- the other tabs (Snippets, Lives, Videos, ...) ---------- */

function buildSection({ artistKey, key, tab, eraLookup, editUrl }) {
  if (!tab || !tab.rows.length) return [];
  let headerRow = findHeaderRow(tab.rows);
  const cols = headerRow >= 0 ? mapColumns(tab.rows[headerRow].cells) : null;
  if (!cols) return [];
  const linkCols = cols.links.length ? cols.links : [];
  const items = [];
  let currentEra = null;
  let group = "";

  tab.rows.forEach((row, index) => {
    if (index <= headerRow) return;
    const links = linkCols.length ? rowLinks(row, cols) : row.links.flat();
    const eraCell = get(row, cols.era);
    const nameCell = get(row, cols.name);
    const filled = row.cells.filter(cell => clean(cell)).length;
    if (!filled) return;

    if (!links.length && (!eraCell || TALLY.test(eraCell))) {
      // an era heading or a group divider
      const heading = firstLine(nameCell || eraCell);
      if (!heading || TALLY.test(heading)) return;
      const era = eraLookup(heading);
      if (era) { currentEra = era; group = ""; } else if (filled <= 3) group = heading;
      return;
    }
    if (!nameCell && !links.length) return;

    const era = (eraCell && eraLookup(eraCell)) || (!eraCell ? currentEra : null);
    const name = parseNameCell(nameCell || "Untitled");
    const fields = [];
    row.cells.forEach((cell, col) => {
      if (col === cols.era || col === cols.name || linkCols.includes(col)) return;
      const value = clean(cell);
      if (!value || value === "N/A") return;
      let label = cols.labels[col] || "";
      if (!label || label.length > 40) label = DATE_LIKE.test(value) ? "Date" : (col === cols.notes ? "Notes" : "Info");
      if (/^notes/i.test(label) || col === cols.notes) label = "Notes";
      fields.push({ label, value });
    });

    items.push({
      id: makeId(artistKey, key, eraCell, nameCell, links.join(" "), index),
      section: key,
      era: era ? era.key : "",
      eraName: era ? era.name : firstLine(eraCell),
      group,
      title: name.title,
      producers: name.producers,
      features: name.features,
      aliases: name.aliases,
      fields,
      links,
      linkNote: links.length ? "" : linkCols.map(i => get(row, i)).filter(Boolean).join(" ").slice(0, 120),
      audio: pickAudio(links),
      sheet: editUrl(tab.gid, index)
    });
  });

  return items;
}

const SECTION_LABELS = {
  snippets: "Snippets",
  stems: "Stems",
  lives: "Lives",
  videos: "Music Videos",
  performances: "Performances",
  samples: "Samples",
  extras: "Extras"
};
const SECTION_ORDER = Object.keys(SECTION_LABELS);

/*
  Loads one tracker from scratch.
    source        { sheetId } or { site }
    fallbackTabs  gids to use if the tab list can't be read
*/
async function loadTracker({ artistKey, source, fallbackTabs = {}, manualCovers = {}, log = console.log }) {
  const started = Date.now();
  const urls = sourceUrls(source);

  let title = "";
  let picked = {};
  try {
    const list = parseTabList(await fetchText(urls.list, 30000));
    title = list.title;
    picked = pickTabs(list.tabs);
  } catch (err) {
    log(`[${artistKey}] tab list failed: ${err.message}`);
  }
  Object.entries(fallbackTabs).forEach(([key, gid]) => {
    if (!picked[key] && gid) picked[key] = { name: key, gid: String(gid) };
  });
  if (!picked.unreleased && !picked.released) {
    throw new Error("Couldn't find an Unreleased or Released tab. Make sure the link is a tracker and it's shared so anyone with the link can view it.");
  }

  // a few at a time: some of these pages are several megabytes
  const tabs = {};
  const entries = Object.entries(picked);
  let at = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (at < entries.length) {
      const [key, tab] = entries[at++];
      try {
        // mirror sites say where each tab lives (/preview/sheet/1.html, /htmlview/sheet/1.html)
        const address = source.site && tab.pageUrl && /^\/[\w\/.-]+$/.test(tab.pageUrl)
          ? `https://${source.site}${tab.pageUrl}`
          : urls.tab(tab.gid);
        const html = await fetchText(address);
        tabs[key] = { name: tab.name, gid: tab.gid, rows: parseSheetHtml(html) };
      } catch (err) {
        log(`[${artistKey}] ${tab.name} failed: ${err.message}`);
      }
    }
  }));

  if (!tabs.unreleased && !tabs.released) throw new Error("The tracker's song tabs couldn't be read. It may not be shared publicly.");

  const { eras, songs } = buildSongs({
    artistKey,
    unreleased: tabs.unreleased,
    released: tabs.released,
    art: tabs.art,
    editUrl: urls.edit,
    manualCovers
  });

  if (!songs.length) throw new Error("No songs could be read from this tracker. Its layout may be too different from the usual tracker template.");

  const byName = new Map();
  eras.forEach(era => [era.name, ...era.aliases].forEach(name => byName.set(looseKey(name), era)));
  const eraLookup = name => byName.get(looseKey(firstLine(name))) || null;

  const sections = {};
  SECTION_ORDER.forEach(key => {
    if (!tabs[key]) return;
    const items = buildSection({ artistKey, key, tab: tabs[key], eraLookup, editUrl: urls.edit });
    // a tab with nothing to open isn't worth a spot in the menu
    if (items.length && items.some(item => item.links.length)) sections[key] = items;
  });

  log(`[${artistKey}] ${songs.length} songs in ${eras.length} eras` +
    Object.entries(sections).map(([key, items]) => `, ${key} ${items.length}`).join("") +
    ` (${((Date.now() - started) / 1000).toFixed(1)}s)`);

  return {
    title,
    sheetUrl: urls.open,
    eras,
    songs,
    sections,
    tabs: [{ key: "songs", label: "Songs", count: songs.length }]
      .concat(SECTION_ORDER.filter(key => sections[key]).map(key => ({ key, label: SECTION_LABELS[key], count: sections[key].length })))
  };
}

/*
  A name for a tracker nobody named: "Updated Lil Uzi Vert Tracker" -> "Lil Uzi Vert",
  "The Lil Yachty Tracker 2025 (@romanifiles)" -> "Lil Yachty".
*/
function guessArtistName(title) {
  let name = clean(title)
    .replace(/^copy of\s+/i, "")
    .replace(/\[[^\]]*\]|\([^)]*\)/g, " ")
    .replace(/\b(the|updated|new|official|backup|music)\b/gi, " ")
    .replace(/\btrack(?:e|ë)r\b.*$/i, "")
    .replace(/\b(v\d+(\.\d+)?|\d{4})\b/g, " ")
    .replace(/[-–—|:]+\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return name || clean(title) || "Tracker";
}

module.exports = {
  loadTracker,
  parseTrackerLink,
  sourceKey,
  sourceFromKey,
  sourceUrls,
  parseSheetHtml,
  parseTabList,
  pickTabs,
  mapColumns,
  findHeaderRow,
  guessArtistName,
  fetchText,
  looseKey,
  clean,
  firstLine,
  pillowsId,
  imgurGgId,
  pixeldrainId,
  pixeldrainFsId,
  exoshareId,
  catboxFile,
  driveId,
  MIRROR_SITES
};
