/**
 * Image format detection for stored assets.
 *
 * Asset filenames used to be derived from the browser-supplied MIME type alone, with a blind
 * `png` fallback. That renamed HEIC photos to `.png` without converting them, so Chromium
 * refused to decode them and the image silently failed to render (NIM-2211). Sniffing the
 * actual bytes keeps the extension honest even when the MIME type is missing or unmapped.
 */

/** Formats Chromium cannot decode, so they must be transcoded before being stored as an asset. */
export const RENDERER_UNSUPPORTED_IMAGE_MIME_TYPES = ['image/heic', 'image/heif'];

export function isRendererUnsupportedImage(mimeType: string): boolean {
  return RENDERER_UNSUPPORTED_IMAGE_MIME_TYPES.includes(mimeType.toLowerCase());
}

const MIME_TO_EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
  'image/avif': 'avif',
  'image/heic': 'heic',
  'image/heif': 'heic'
};

/** ISO-BMFF brands that identify a HEIC/HEIF still image. */
const HEIF_BRANDS = ['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1'];

function startsWith(buffer: Buffer, bytes: number[], offset = 0): boolean {
  if (buffer.length < offset + bytes.length) return false;
  return bytes.every((byte, index) => buffer[offset + index] === byte);
}

/**
 * Identify an image's extension from its magic bytes. Returns null for anything unrecognized.
 */
export function sniffImageExtension(buffer: Buffer): string | null {
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return 'jpg';
  if (startsWith(buffer, [0x47, 0x49, 0x46, 0x38])) return 'gif';
  if (startsWith(buffer, [0x42, 0x4d])) return 'bmp';
  if (startsWith(buffer, [0x49, 0x49, 0x2a, 0x00]) || startsWith(buffer, [0x4d, 0x4d, 0x00, 0x2a])) {
    return 'tiff';
  }

  // RIFF container: bytes 8-11 carry the form type.
  if (startsWith(buffer, [0x52, 0x49, 0x46, 0x46]) && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return 'webp';
  }

  // ISO base media file format: 'ftyp' at offset 4, brand at offset 8.
  if (buffer.length >= 12 && buffer.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buffer.toString('ascii', 8, 12).toLowerCase();
    if (brand === 'avif' || brand === 'avis') return 'avif';
    if (HEIF_BRANDS.includes(brand)) return 'heic';
  }

  // SVG is text; the root element may trail an XML declaration, comments, or a doctype.
  const head = buffer.toString('utf8', 0, Math.min(buffer.length, 1024)).trimStart();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) {
    return 'svg';
  }

  return null;
}

/**
 * Resolve the extension an image should be stored under.
 *
 * The bytes win over the declared MIME type: browsers report an empty `File.type` for some drag
 * sources, and a mislabeled buffer would otherwise get a filename that no decoder can honor.
 * Falls back to the MIME map, then to `bin` so an unidentifiable file is never disguised as an image.
 */
export function resolveImageExtension(mimeType: string, buffer: Buffer): string {
  return sniffImageExtension(buffer) ?? MIME_TO_EXTENSION[mimeType.toLowerCase()] ?? 'bin';
}
