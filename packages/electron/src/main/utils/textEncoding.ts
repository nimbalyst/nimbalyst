import { isUtf8 } from 'node:buffer';
import * as chardet from 'chardet';

/**
 * Decode a text file's raw bytes to a string, preferring UTF-8.
 *
 * Why this exists: the write path always saves as UTF-8, but the read path used
 * to trust chardet's guess directly. chardet misclassifies mostly-ASCII UTF-8
 * files that contain a few multibyte chars (em dash, curly quotes/apostrophes)
 * as windows-1252 / ISO-8859-1. Decoding those bytes as latin1 turns each UTF-8
 * lead byte (0xE2 ...) into `â`-style mojibake, and because the mojibake re-read
 * never equals the editor's real UTF-8 buffer, the "file changed on disk" echo
 * check never matches -> reload loop + lost edits (GitHub #794, NIM-1575).
 *
 * Strategy: honor an explicit BOM, otherwise decode as UTF-8 whenever the bytes
 * are valid UTF-8 (matching the write path). Only genuinely non-UTF-8 bytes fall
 * back to chardet detection.
 */

// chardet label -> Node.js encoding name. Only consulted for the non-UTF-8 fallback.
const CHARDET_TO_NODE: Record<string, BufferEncoding> = {
  'UTF-8': 'utf8',
  'UTF-16LE': 'utf16le',
  'UTF-16BE': 'utf16le', // Node lacks utf16be; closest available
  'ISO-8859-1': 'latin1',
  'windows-1252': 'latin1',
  'Shift_JIS': 'utf8', // unsupported by Node's decoder; best-effort
  'GB18030': 'utf8', // unsupported by Node's decoder; best-effort
};

export interface DecodedText {
  content: string;
  encoding: BufferEncoding;
}

export function decodeTextFileBuffer(buffer: Buffer): DecodedText {
  // UTF-8 BOM -> strip it and decode as UTF-8.
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { content: buffer.toString('utf8', 3), encoding: 'utf8' };
  }
  // UTF-16 LE BOM.
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { content: buffer.toString('utf16le', 2), encoding: 'utf16le' };
  }
  // UTF-16 BE BOM: byte-swap to LE (Node has no utf16be decoder).
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.from(buffer.subarray(2));
    swapped.swap16();
    return { content: swapped.toString('utf16le'), encoding: 'utf16le' };
  }

  // Prefer UTF-8 whenever the bytes are valid UTF-8 (also covers pure ASCII).
  // This is what the write path produces, so round-tripping never corrupts.
  if (isUtf8(buffer)) {
    return { content: buffer.toString('utf8'), encoding: 'utf8' };
  }

  // Genuinely not UTF-8 -> fall back to statistical detection.
  const detected = chardet.detect(buffer);
  const encoding = (detected && CHARDET_TO_NODE[detected]) || 'utf8';
  return { content: buffer.toString(encoding), encoding };
}
