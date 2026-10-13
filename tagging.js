/*
  Writes the tracker's details into downloaded files, ported from
  tracker-player's tagger (same ID3 and Ogg code), plus FLAC.

  Files off pillows/imgur carry no tags, so they'd land in a music library as
  "track01" by "Unknown Artist". This puts in the title, artist, the era as
  the album, the year, track number, the producer credit as the comment, and
  the era cover.

    MP3        -> ID3v2.3 (UTF-16 text, so "Trëndi" survives)
    Ogg/Opus   -> Vorbis comments + METADATA_BLOCK_PICTURE (audio pages untouched)
    FLAC       -> Vorbis comment block + PICTURE block
    WAV        -> ID3 in an "id3 " chunk (what foobar2000/Mp3tag/MusicBee read)
    M4A        -> passed through as-is
*/

/* ---------- what kind of file is it ---------- */

function sniff(audio) {
  const head = audio.toString("ascii", 0, 12);
  if (audio.length > 2 && (head.startsWith("ID3") || (audio[0] === 0xff && (audio[1] & 0xe0) === 0xe0))) return { kind: "mp3", ext: "mp3" };
  if (head.startsWith("OggS")) {
    const opus = audio.indexOf("OpusHead", 0, "ascii");
    return { kind: "ogg", ext: opus >= 0 && opus < 200 ? "opus" : "ogg" };
  }
  if (head.startsWith("fLaC")) return { kind: "flac", ext: "flac" };
  if (head.startsWith("RIFF")) return { kind: "wav", ext: "wav" };
  if (head.slice(4, 8) === "ftyp") return { kind: "m4a", ext: head.slice(8, 11) === "M4A" ? "m4a" : "mp4" };
  return { kind: "other", ext: "" };
}

/* ---------- ID3v2.3 (from tracker-player) ---------- */

function id3Frame(id, body) {
  const head = Buffer.alloc(10);
  head.write(id, 0, 4, "ascii");
  head.writeUInt32BE(body.length, 4);
  return Buffer.concat([head, body]);
}

const utf16 = text => Buffer.from("﻿" + String(text), "utf16le");

const id3TextFrame = (id, text) => id3Frame(id, Buffer.concat([Buffer.from([0x01]), utf16(text)]));

function id3CommentFrame(text) {
  return id3Frame("COMM", Buffer.concat([
    Buffer.from([0x01]),
    Buffer.from("eng", "ascii"),
    utf16(""), Buffer.from([0x00, 0x00]),
    utf16(text)
  ]));
}

function id3PictureFrame(mime, image) {
  return id3Frame("APIC", Buffer.concat([
    Buffer.from([0x00]),
    Buffer.from(mime, "ascii"), Buffer.from([0x00]),
    Buffer.from([0x03]),
    Buffer.from([0x00]),
    image
  ]));
}

function synchsafe(size) {
  return Buffer.from([(size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f]);
}

function buildId3Tag(tags, cover) {
  const frames = [];
  const add = (id, value) => { if (value) frames.push(id3TextFrame(id, value)); };

  add("TIT2", tags.title);
  add("TPE1", tags.artist);
  add("TPE2", tags.albumArtist);
  add("TALB", tags.album);
  add("TCON", tags.genre);
  add("TYER", tags.year);
  add("TRCK", tags.track);
  if (tags.comment) frames.push(id3CommentFrame(tags.comment));
  if (cover && cover.image && cover.image.length) frames.push(id3PictureFrame(cover.mime, cover.image));

  if (!frames.length) return Buffer.alloc(0);
  const body = Buffer.concat(frames);
  return Buffer.concat([Buffer.from("ID3"), Buffer.from([3, 0, 0]), synchsafe(body.length), body]);
}

function stripExistingTags(audio) {
  let out = audio;
  if (out.length > 10 && out.toString("ascii", 0, 3) === "ID3") {
    const size = ((out[6] & 0x7f) << 21) | ((out[7] & 0x7f) << 14) | ((out[8] & 0x7f) << 7) | (out[9] & 0x7f);
    const footer = (out[5] & 0x10) ? 10 : 0;
    out = out.subarray(10 + size + footer);
  }
  if (out.length > 128 && out.toString("ascii", out.length - 128, out.length - 125) === "TAG") {
    out = out.subarray(0, out.length - 128);
  }
  return out;
}

/* ---------- Ogg (from tracker-player) ---------- */

const OGG_CRC = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let bit = 0; bit < 8; bit++) r = (r & 0x80000000) ? ((r << 1) ^ 0x04c11db7) : (r << 1);
    table[i] = r >>> 0;
  }
  return table;
})();

function oggChecksum(page) {
  let crc = 0;
  for (let i = 0; i < page.length; i++) crc = ((crc << 8) ^ OGG_CRC[((crc >>> 24) & 0xff) ^ page[i]]) >>> 0;
  return crc >>> 0;
}

function readOggPages(buffer) {
  const pages = [];
  let at = 0;
  while (at + 27 <= buffer.length) {
    if (buffer.toString("ascii", at, at + 4) !== "OggS") return null;
    const count = buffer[at + 26];
    const table = buffer.subarray(at + 27, at + 27 + count);
    const dataStart = at + 27 + count;
    const end = dataStart + table.reduce((total, value) => total + value, 0);
    if (end > buffer.length) return null;
    pages.push({
      start: at, end, dataStart,
      serial: buffer.readUInt32LE(at + 14),
      segments: Array.from(table),
      bytes: buffer.subarray(at, end)
    });
    at = end;
  }
  return pages.length ? pages : null;
}

function packetsOfPage(buffer, page) {
  const packets = [];
  let offset = page.dataStart;
  let current = [];
  page.segments.forEach(size => {
    current.push(buffer.subarray(offset, offset + size));
    offset += size;
    if (size < 255) { packets.push(Buffer.concat(current)); current = []; }
  });
  return { packets, unfinished: current.length ? Buffer.concat(current) : null };
}

function oggPagesFor(packet, serial, firstSequence, granule) {
  const sizes = [];
  let left = packet.length;
  while (left >= 255) { sizes.push(255); left -= 255; }
  sizes.push(left);

  const pages = [];
  let taken = 0, offset = 0, sequence = firstSequence, continued = false;
  while (taken < sizes.length) {
    const count = Math.min(255, sizes.length - taken);
    const table = sizes.slice(taken, taken + count);
    const length = table.reduce((total, value) => total + value, 0);
    const header = Buffer.alloc(27 + count);
    header.write("OggS", 0, "ascii");
    header[5] = continued ? 0x01 : 0x00;
    header.writeUInt32LE(granule >>> 0, 6);
    header.writeUInt32LE(0, 10);
    header.writeUInt32LE(serial, 14);
    header.writeUInt32LE(sequence >>> 0, 18);
    header[26] = count;
    table.forEach((value, i) => { header[27 + i] = value; });
    const page = Buffer.concat([header, packet.subarray(offset, offset + length)]);
    page.writeUInt32LE(oggChecksum(page), 22);
    pages.push(page);
    taken += count;
    offset += length;
    sequence++;
    continued = true;
  }
  return pages;
}

function vorbisCommentBody(vendor, comments) {
  const parts = [Buffer.alloc(4), Buffer.from(vendor, "utf8")];
  parts[0].writeUInt32LE(parts[1].length, 0);
  const count = Buffer.alloc(4);
  count.writeUInt32LE(comments.length, 0);
  parts.push(count);
  comments.forEach(text => {
    const line = Buffer.from(text, "utf8");
    const size = Buffer.alloc(4);
    size.writeUInt32LE(line.length, 0);
    parts.push(size, line);
  });
  return Buffer.concat(parts);
}

function readVendor(packet, offset) {
  if (packet.length < offset + 4) return "";
  const length = packet.readUInt32LE(offset);
  return packet.length >= offset + 4 + length ? packet.toString("utf8", offset + 4, offset + 4 + length) : "";
}

function imageSize(image, mime) {
  try {
    if (/png/i.test(mime) && image.length > 24) return { width: image.readUInt32BE(16), height: image.readUInt32BE(20) };
    if (/jpe?g/i.test(mime)) {
      let at = 2;
      while (at + 9 < image.length) {
        if (image[at] !== 0xff) { at++; continue; }
        const marker = image[at + 1];
        const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isFrame) return { height: image.readUInt16BE(at + 5), width: image.readUInt16BE(at + 7) };
        at += 2 + image.readUInt16BE(at + 2);
      }
    }
  } catch { /* zero is fine */ }
  return { width: 0, height: 0 };
}

// FLAC PICTURE block body (also used base64'd inside Ogg comments)
function pictureBlock(cover) {
  const mime = Buffer.from(cover.mime, "ascii");
  const { width, height } = imageSize(cover.image, cover.mime);
  const block = Buffer.alloc(32 + mime.length + cover.image.length);
  let at = 0;
  const put = value => { block.writeUInt32BE(value, at); at += 4; };
  put(3);
  put(mime.length);
  mime.copy(block, at); at += mime.length;
  put(0);
  put(width);
  put(height);
  put(24);
  put(0);
  put(cover.image.length);
  cover.image.copy(block, at);
  return block;
}

function vorbisLines(tags) {
  const lines = [];
  const add = (key, value) => { if (value) lines.push(`${key}=${value}`); };
  add("TITLE", tags.title);
  add("ARTIST", tags.artist);
  add("ALBUMARTIST", tags.albumArtist);
  add("ALBUM", tags.album);
  add("GENRE", tags.genre);
  add("DATE", tags.year);
  add("TRACKNUMBER", tags.track);
  add("COMMENT", tags.comment);
  return lines;
}

function taggedOgg(audio, tags, cover) {
  const pages = readOggPages(audio);
  if (!pages || pages.length < 2) return null;
  const first = packetsOfPage(audio, pages[0]).packets[0];
  if (!first) return null;

  const opus = first.length > 8 && first.toString("ascii", 0, 8) === "OpusHead";
  const vorbis = first.length > 7 && first[0] === 0x01 && first.toString("ascii", 1, 7) === "vorbis";
  if (!opus && !vorbis) return null;

  const serial = pages[0].serial;
  const wanted = opus ? 1 : 2;
  const headers = [];
  let carried = null;
  let page = 1;

  for (; page < pages.length && headers.length < wanted; page++) {
    if (pages[page].serial !== serial) return null;
    const { packets, unfinished } = packetsOfPage(audio, pages[page]);
    const all = carried ? [Buffer.concat([carried, packets.shift() || Buffer.alloc(0)]), ...packets] : packets;
    all.forEach(packet => { if (headers.length < wanted) headers.push(packet); });
    carried = unfinished;
    if (headers.length === wanted && (unfinished || all.length > wanted)) return null;
  }
  if (headers.length < wanted || carried) return null;

  const comment = headers[0];
  const prefix = opus ? 8 : 7;
  if (comment.length < prefix + 4) return null;
  if (opus && comment.toString("ascii", 0, 8) !== "OpusTags") return null;
  if (vorbis && !(comment[0] === 0x03 && comment.toString("ascii", 1, 7) === "vorbis")) return null;

  const lines = vorbisLines(tags);
  if (cover && cover.image && cover.image.length) lines.push(`METADATA_BLOCK_PICTURE=${pictureBlock(cover).toString("base64")}`);
  if (!lines.length) return null;

  const body = vorbisCommentBody(readVendor(comment, prefix), lines);
  const rebuilt = opus
    ? Buffer.concat([Buffer.from("OpusTags", "ascii"), body])
    : Buffer.concat([Buffer.from([0x03]), Buffer.from("vorbis", "ascii"), body, Buffer.from([0x01])]);

  const out = [pages[0].bytes];
  let sequence = 1;
  [rebuilt, ...headers.slice(1)].forEach(packet => {
    const built = oggPagesFor(packet, serial, sequence, 0);
    sequence += built.length;
    out.push(...built);
  });
  for (; page < pages.length; page++) {
    const copy = Buffer.from(pages[page].bytes);
    copy.writeUInt32LE(sequence >>> 0, 18);
    copy.writeUInt32LE(0, 22);
    copy.writeUInt32LE(oggChecksum(copy), 22);
    out.push(copy);
    sequence++;
  }
  return Buffer.concat(out);
}

/* ---------- FLAC ---------- */

function taggedFlac(audio, tags, cover) {
  // fLaC, then metadata blocks: 1 byte (last flag + type), 3 byte length
  let at = 4;
  const kept = [];
  let vendor = "archivedownloader";
  let last = false;

  while (!last && at + 4 <= audio.length) {
    const flag = audio[at];
    last = Boolean(flag & 0x80);
    const type = flag & 0x7f;
    const length = audio.readUIntBE(at + 1, 3);
    const body = audio.subarray(at + 4, at + 4 + length);
    if (at + 4 + length > audio.length) return null;
    if (type === 4) vendor = readVendor(body, 0) || vendor;   // old comments: dropped
    else if (type !== 6 && type !== 1) kept.push({ type, body }); // old pictures and padding: dropped
    at += 4 + length;
  }
  if (!kept.length || kept[0].type !== 0) return null; // STREAMINFO must be first

  const blocks = [...kept, { type: 4, body: vorbisCommentBody(vendor, vorbisLines(tags)) }];
  if (cover && cover.image && cover.image.length && cover.image.length < 0xffffff - 100) blocks.push({ type: 6, body: pictureBlock(cover) });
  blocks.push({ type: 1, body: Buffer.alloc(1024) }); // a little padding for other taggers

  const parts = [Buffer.from("fLaC", "ascii")];
  blocks.forEach((block, i) => {
    const head = Buffer.alloc(4);
    head[0] = (i === blocks.length - 1 ? 0x80 : 0) | block.type;
    head.writeUIntBE(block.body.length, 1, 3);
    parts.push(head, block.body);
  });
  parts.push(audio.subarray(at));
  return Buffer.concat(parts);
}

/* ---------- WAV ----------
   WAV has no real tag of its own; the common answer (foobar2000, Mp3tag,
   MusicBee, mutagen and others read it) is an ID3 tag in an "id3 " chunk. */

function taggedWav(audio, tags, cover) {
  if (audio.toString("ascii", 0, 4) !== "RIFF" || audio.toString("ascii", 8, 12) !== "WAVE") return null;
  const chunks = [];
  let at = 12;
  while (at + 8 <= audio.length) {
    const id = audio.toString("ascii", at, at + 4);
    const size = audio.readUInt32LE(at + 4);
    const end = Math.min(audio.length, at + 8 + size + (size & 1));
    if (!/^(id3 |ID3 )$/.test(id)) chunks.push(audio.subarray(at, end));
    at = end;
  }
  const tag = buildId3Tag(tags, cover);
  if (!tag.length) return null;
  const head = Buffer.alloc(8);
  head.write("id3 ", 0, "ascii");
  head.writeUInt32LE(tag.length, 4);
  const pad = tag.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0);
  const body = Buffer.concat([Buffer.from("WAVE", "ascii"), ...chunks, head, tag, pad]);
  const riff = Buffer.alloc(8);
  riff.write("RIFF", 0, "ascii");
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}

/* ---------- public ---------- */

// "⭐️ Sleep Monëy [V2]" -> "Sleep Monëy [V2]"
function cleanTitle(title) {
  return String(title || "").replace(/^[\p{Extended_Pictographic}⭐✨️‍\s]+/u, "").trim() || String(title || "song");
}

/*
  audio: Buffer of the whole file
  returns { file, ext, tagged, kind }
*/
function tagAudio(audio, tags, cover) {
  const { kind, ext } = sniff(audio);
  let file = audio;
  let tagged = false;

  try {
    if (kind === "mp3") {
      const tag = buildId3Tag(tags, cover);
      if (tag.length) { file = Buffer.concat([tag, stripExistingTags(audio)]); tagged = true; }
    } else if (kind === "ogg") {
      const rebuilt = taggedOgg(audio, tags, cover);
      if (rebuilt) { file = rebuilt; tagged = true; }
    } else if (kind === "wav") {
      const rebuilt = taggedWav(audio, tags, cover);
      if (rebuilt) { file = rebuilt; tagged = true; }
    } else if (kind === "flac") {
      const rebuilt = taggedFlac(audio, tags, cover);
      if (rebuilt) { file = rebuilt; tagged = true; }
    }
  } catch (err) {
    console.warn(`[tag] ${tags.title}: ${err.message}`);
    file = audio;
    tagged = false;
  }

  return { file, ext, kind, tagged };
}

module.exports = { tagAudio, cleanTitle, sniff };
