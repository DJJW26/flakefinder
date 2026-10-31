import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

/**
 * Decode a report file's bytes into a string.
 *
 * Handles UTF-8 (with or without BOM) and UTF-16 LE/BE with a BOM, which is
 * what PowerShell 5.1's `>` redirection writes. BOM-less UTF-16 is detected
 * heuristically from NUL bytes in the first 512 bytes. Gzip-compressed
 * reports (`report.xml.gz`) are decompressed first.
 */
export function decodeText(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    try {
      return decodeText(gunzipSync(buf, { maxOutputLength: 512 * 1024 * 1024 }));
    } catch {
      // Corrupt/truncated gzip: fall through so the parser layer reports it.
    }
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString('utf8');
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.subarray(2).toString('utf16le');
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return swap16(buf.subarray(2)).toString('utf16le');
  }
  const probe = Math.min(buf.length, 512) & ~1;
  if (probe >= 4) {
    let evenNul = 0;
    let oddNul = 0;
    for (let i = 0; i < probe; i += 2) {
      if (buf[i] === 0) evenNul++;
      if (buf[i + 1] === 0) oddNul++;
    }
    const pairs = probe / 2;
    if (oddNul > pairs * 0.4 && evenNul === 0) return buf.toString('utf16le');
    if (evenNul > pairs * 0.4 && oddNul === 0) return swap16(buf).toString('utf16le');
  }
  return buf.toString('utf8');
}

function swap16(buf: Buffer): Buffer {
  const out = Buffer.from(buf.subarray(0, buf.length & ~1));
  out.swap16();
  return out;
}

/** Read a report file as text, decoding UTF-8 / UTF-16 (see decodeText). */
export function readTextFile(file: string): string {
  return decodeText(readFileSync(file));
}
