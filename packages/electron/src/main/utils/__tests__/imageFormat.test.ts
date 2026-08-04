import { describe, it, expect } from 'vitest';
import { resolveImageExtension, sniffImageExtension, isRendererUnsupportedImage } from '../imageFormat';

/** Minimal ISO-BMFF header: box size, 'ftyp', then the brand. Matches what an iPhone HEIC starts with. */
function isoBmffHeader(brand: string): Buffer {
  const header = Buffer.alloc(32);
  header.writeUInt32BE(0x2c, 0);
  header.write('ftyp', 4, 'ascii');
  header.write(brand, 8, 'ascii');
  return header;
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

describe('resolveImageExtension', () => {
  it('does not label HEIC bytes as png', () => {
    // NIM-2211: a blind `png` fallback wrote raw HEIC under a .png name, which Chromium can't decode.
    expect(resolveImageExtension('image/heic', isoBmffHeader('heic'))).toBe('heic');
  });

  it('trusts the bytes over an empty or wrong MIME type', () => {
    expect(resolveImageExtension('', PNG)).toBe('png');
    expect(resolveImageExtension('image/png', JPEG)).toBe('jpg');
  });

  it('falls back to the MIME map when the bytes are unrecognized', () => {
    expect(resolveImageExtension('image/svg+xml', Buffer.from('<!-- comment -->'))).toBe('svg');
  });

  it('never disguises unidentifiable data as an image', () => {
    expect(resolveImageExtension('', Buffer.from('not an image at all'))).toBe('bin');
  });
});

describe('sniffImageExtension', () => {
  it.each([
    ['png', PNG],
    ['jpg', JPEG],
    ['gif', Buffer.from('GIF89a')],
    ['bmp', Buffer.from([0x42, 0x4d, 0x00, 0x00])],
    ['tiff', Buffer.from([0x49, 0x49, 0x2a, 0x00])],
    ['webp', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')])],
    ['heic', isoBmffHeader('heic')],
    ['heic', isoBmffHeader('mif1')],
    ['avif', isoBmffHeader('avif')],
    ['svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')],
    ['svg', Buffer.from('<?xml version="1.0"?>\n<svg></svg>')]
  ])('detects %s', (expected, buffer) => {
    expect(sniffImageExtension(buffer)).toBe(expected);
  });

  it('returns null for non-image data', () => {
    expect(sniffImageExtension(Buffer.from('plain text'))).toBeNull();
  });

  it('does not read past the end of a short buffer', () => {
    expect(sniffImageExtension(Buffer.alloc(0))).toBeNull();
    expect(sniffImageExtension(Buffer.from([0x89, 0x50]))).toBeNull();
  });
});

describe('isRendererUnsupportedImage', () => {
  it('flags the formats Chromium cannot decode', () => {
    expect(isRendererUnsupportedImage('image/heic')).toBe(true);
    expect(isRendererUnsupportedImage('IMAGE/HEIF')).toBe(true);
    expect(isRendererUnsupportedImage('image/png')).toBe(false);
  });
});
