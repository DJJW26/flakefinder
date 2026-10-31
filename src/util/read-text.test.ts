import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodeText } from './read-text.js';

const s = '<?xml version="1.0"?><testsuite name="ü"/>';

describe('decodeText', () => {
  it('passes plain UTF-8 through', () => {
    expect(decodeText(Buffer.from(s, 'utf8'))).toBe(s);
  });
  it('strips a UTF-8 BOM', () => {
    expect(decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(s)]))).toBe(s);
  });
  it('decodes UTF-16LE with BOM', () => {
    expect(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')]))).toBe(
      s,
    );
  });
  it('decodes UTF-16BE with BOM', () => {
    const be = Buffer.from(s, 'utf16le').swap16();
    expect(decodeText(Buffer.concat([Buffer.from([0xfe, 0xff]), be]))).toBe(s);
  });
  it('decodes BOM-less UTF-16LE and BE', () => {
    expect(decodeText(Buffer.from(s, 'utf16le'))).toBe(s);
    expect(decodeText(Buffer.from(s, 'utf16le').swap16())).toBe(s);
  });
  it('decompresses gzip (incl. UTF-16 inside)', () => {
    expect(decodeText(gzipSync(Buffer.from(s)))).toBe(s);
    expect(
      decodeText(gzipSync(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')]))),
    ).toBe(s);
  });
});
