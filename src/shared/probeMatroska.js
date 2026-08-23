'use strict';

/**
 * Read the codecs out of a Matroska/WebM file by parsing the container directly.
 *
 * Why not just call ffprobe: because then knowing whether a file will play
 * requires ffmpeg to be installed, and the honest answer for most .mkv rips is
 * "the video is fine, the audio is AC3". We want to be able to say that with no
 * dependencies at all, so the app degrades to useful rather than to nothing.
 *
 * Only the file header is needed — Tracks sits near the start, well before any
 * actual media data — so the caller reads a couple of MB, not the whole episode.
 *
 * Pure and synchronous: takes a Uint8Array, returns codec ids.
 */

// EBML element ids we care about, stored with their length-marker bits intact.
const ID = {
  EBML: 0x1a45dfa3,
  SEGMENT: 0x18538067,
  TRACKS: 0x1654ae6b,
  TRACK_ENTRY: 0xae,
  TRACK_TYPE: 0x83,
  TRACK_NUMBER: 0xd7,
  CODEC_ID: 0x86,
  CODEC_NAME: 0x258688,
  // Track language and flags — what makes it possible to pick the English
  // audio out of a dual-audio release rather than whichever came first.
  LANGUAGE: 0x22b59c,        // ISO 639-2, e.g. "eng", "jpn"
  LANGUAGE_BCP47: 0x22b59d,  // newer files use this instead, e.g. "en", "ja"
  TRACK_NAME: 0x536e,        // "English", "Commentary", "Signs & Songs"
  FLAG_DEFAULT: 0x88,
  FLAG_FORCED: 0x55aa,
  CLUSTER: 0x1f43b675,
  // Containers we descend into while hunting for Tracks.
  SEEK_HEAD: 0x114d9b74,
  INFO: 0x1549a966,
};

const TRACK_TYPE = { 1: 'video', 2: 'audio', 17: 'subtitle' };

/**
 * Element ids keep their marker bit (that is what makes them unique), so this
 * returns the raw big-endian bytes rather than stripping anything.
 */
function readId(buf, pos) {
  const first = buf[pos];
  if (first === undefined || first === 0) return null;
  let length = 1;
  let mask = 0x80;
  while (length <= 4 && (first & mask) === 0) { mask >>= 1; length += 1; }
  if (length > 4) return null;
  let value = 0;
  for (let i = 0; i < length; i += 1) {
    const byte = buf[pos + i];
    if (byte === undefined) return null;
    value = value * 256 + byte;
  }
  return { value, length };
}

/**
 * Sizes are VINTs with the marker bit removed. An all-ones payload means
 * "unknown size", which is legal for Segment in a streamed file and must not be
 * mistaken for a gigantic length.
 */
function readSize(buf, pos) {
  const first = buf[pos];
  if (first === undefined || first === 0) return null;
  let length = 1;
  let mask = 0x80;
  while (length <= 8 && (first & mask) === 0) { mask >>= 1; length += 1; }
  if (length > 8) return null;

  let value = first & (mask - 1);
  let unknown = value === mask - 1;
  for (let i = 1; i < length; i += 1) {
    const byte = buf[pos + i];
    if (byte === undefined) return null;
    value = value * 256 + byte;
    if (byte !== 0xff) unknown = false;
  }
  if (!Number.isSafeInteger(value)) return { value: 0, length, unknown: true };
  return { value, length, unknown };
}

function readAsciiString(buf, pos, length) {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    const byte = buf[pos + i];
    if (byte === undefined) break;
    if (byte === 0) break; // CodecIDs are zero-padded in some muxers
    out += String.fromCharCode(byte);
  }
  return out;
}

function readUint(buf, pos, length) {
  let value = 0;
  for (let i = 0; i < length; i += 1) {
    const byte = buf[pos + i];
    if (byte === undefined) return value;
    value = value * 256 + byte;
  }
  return value;
}

/** Track names are UTF-8; codec ids and language codes are plain ASCII. */
function readUtf8String(buf, pos, length) {
  const slice = buf.subarray(pos, pos + length);
  try {
    return new TextDecoder('utf-8').decode(slice).replace(/\0+$/, '');
  } catch {
    return readAsciiString(buf, pos, length);
  }
}

/**
 * Parse the children of one TrackEntry.
 *
 * `language` defaults to 'eng' when the element is absent, which is not a guess
 * — it is what the Matroska spec says an omitted Language means.
 */
function parseTrackEntry(buf, start, end) {
  const track = {
    type: null,
    codecId: null,
    codecName: null,
    number: null,
    language: null,
    languageBcp47: null,
    name: null,
    default: false,
    forced: false,
  };
  let pos = start;

  while (pos < end) {
    const id = readId(buf, pos);
    if (!id) break;
    const size = readSize(buf, pos + id.length);
    if (!size) break;
    const dataStart = pos + id.length + size.length;
    const dataEnd = size.unknown ? end : Math.min(dataStart + size.value, end);

    switch (id.value) {
      case ID.TRACK_TYPE:
        track.type = TRACK_TYPE[readUint(buf, dataStart, size.value)] || null;
        break;
      case ID.CODEC_ID:
        track.codecId = readAsciiString(buf, dataStart, size.value);
        break;
      case ID.CODEC_NAME:
        track.codecName = readAsciiString(buf, dataStart, size.value);
        break;
      case ID.TRACK_NUMBER:
        track.number = readUint(buf, dataStart, size.value);
        break;
      case ID.LANGUAGE:
        track.language = readAsciiString(buf, dataStart, size.value);
        break;
      case ID.LANGUAGE_BCP47:
        track.languageBcp47 = readAsciiString(buf, dataStart, size.value);
        break;
      case ID.TRACK_NAME:
        track.name = readUtf8String(buf, dataStart, size.value);
        break;
      case ID.FLAG_DEFAULT:
        track.default = readUint(buf, dataStart, size.value) === 1;
        break;
      case ID.FLAG_FORCED:
        track.forced = readUint(buf, dataStart, size.value) === 1;
        break;
      default:
        break;
    }
    pos = dataEnd;
    if (dataEnd <= dataStart && size.value === 0) pos = dataStart; // zero-length element
    if (pos <= start) break; // no forward progress: corrupt, bail out
  }
  return track;
}

/**
 * @param {Uint8Array} head  the first few MB of the file
 * @returns {{ok: boolean, tracks: Array, reason?: string, truncated?: boolean}}
 */
function probeMatroska(head) {
  if (!head || head.length < 4) return { ok: false, tracks: [], reason: 'empty file' };

  const magic = readId(head, 0);
  if (!magic || magic.value !== ID.EBML) {
    return { ok: false, tracks: [], reason: 'not a Matroska file' };
  }

  // Skip the EBML header, then find Segment.
  const headerSize = readSize(head, magic.length);
  if (!headerSize) return { ok: false, tracks: [], reason: 'unreadable EBML header' };
  let pos = magic.length + headerSize.length + headerSize.value;

  const segment = readId(head, pos);
  if (!segment || segment.value !== ID.SEGMENT) {
    return { ok: false, tracks: [], reason: 'no Segment element' };
  }
  const segmentSize = readSize(head, pos + segment.length);
  if (!segmentSize) return { ok: false, tracks: [], reason: 'unreadable Segment size' };
  pos = pos + segment.length + segmentSize.length;

  // Walk the Segment's direct children looking for Tracks.
  while (pos < head.length) {
    const id = readId(head, pos);
    if (!id) break;
    const size = readSize(head, pos + id.length);
    if (!size) break;
    const dataStart = pos + id.length + size.length;

    if (id.value === ID.TRACKS) {
      const end = Math.min(dataStart + size.value, head.length);
      const truncated = dataStart + size.value > head.length;
      const tracks = [];

      let entryPos = dataStart;
      while (entryPos < end) {
        const entryId = readId(head, entryPos);
        if (!entryId) break;
        const entrySize = readSize(head, entryPos + entryId.length);
        if (!entrySize) break;
        const entryStart = entryPos + entryId.length + entrySize.length;
        const entryEnd = Math.min(entryStart + entrySize.value, end);

        if (entryId.value === ID.TRACK_ENTRY) {
          tracks.push(parseTrackEntry(head, entryStart, entryEnd));
        }
        if (entryEnd <= entryPos) break;
        entryPos = entryEnd;
      }
      return { ok: true, tracks: tracks.filter((t) => t.codecId), truncated };
    }

    // Reaching media data means Tracks was not in the part we read.
    if (id.value === ID.CLUSTER) {
      return { ok: false, tracks: [], reason: 'Tracks not found before media data' };
    }

    if (size.unknown) break;
    const next = dataStart + size.value;
    if (next <= pos) break; // no forward progress
    pos = next;
  }

  return { ok: false, tracks: [], reason: 'Tracks not found in file header', truncated: true };
}

module.exports = { probeMatroska, readId, readSize, ID };
