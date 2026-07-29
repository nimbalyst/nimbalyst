import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// ElectronDocumentService transitively imports the database initializer and the workspace watcher
// chain, which touch Electron's `app` global at module load. Mock them so the import chain
// evaluates cleanly under vitest -- matches the sibling metadata/inlineIdentity tests.
vi.mock('../../database/PGLiteDatabaseWorker', () => ({
  database: { query: vi.fn() },
}));

vi.mock('../TrackerSyncManager', () => ({
  syncTrackerItem: vi.fn(),
  unsyncTrackerItem: vi.fn(),
  isTrackerSyncActive: vi.fn(() => false),
}));

// Real HEIC decoding needs libheif's WASM runtime; the conversion itself is covered by
// ImageCompressor's own tests. Here we only care that storeAsset routes through it.
vi.mock('../ImageCompressor', () => ({
  compressImage: vi.fn(),
}));

import { ElectronDocumentService } from '../ElectronDocumentService';
import { compressImage } from '../ImageCompressor';

const compressImageMock = vi.mocked(compressImage);

/** Minimal ISO-BMFF header matching what an iPhone HEIC photo starts with. */
function heicBuffer(): Buffer {
  const header = Buffer.alloc(64);
  header.writeUInt32BE(0x2c, 0);
  header.write('ftyp', 4, 'ascii');
  header.write('heic', 8, 'ascii');
  return header;
}

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03]);
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

function compressionResult(buffer: Buffer, mimeType: string) {
  return {
    buffer,
    mimeType,
    originalSize: 64,
    compressedSize: buffer.length,
    width: 10,
    height: 10,
    wasCompressed: true,
  };
}

describe('ElectronDocumentService.storeAsset', () => {
  let tempDir: string;
  let service: ElectronDocumentService;
  let documentPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'store-asset-test-'));
    service = new ElectronDocumentService(tempDir);
    documentPath = path.join(tempDir, 'note.md');
    compressImageMock.mockReset();
  });

  afterEach(async () => {
    service?.destroy();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function readStoredAsset(relativePath: string): Promise<Buffer> {
    return fs.readFile(path.join(tempDir, relativePath));
  }

  it('converts a pasted HEIC photo instead of storing it under a .png name', async () => {
    // NIM-2211: raw HEIC bytes named .png render as a permanently broken image in Chromium.
    compressImageMock.mockResolvedValue(compressionResult(JPEG_BYTES, 'image/jpeg'));

    const result = await service.storeAsset(heicBuffer(), 'image/heic', documentPath);

    expect(compressImageMock).toHaveBeenCalledOnce();
    expect(result.extension).toBe('jpg');
    expect(result.relativePath).toBe(`assets/${result.hash}.jpg`);
    expect(await readStoredAsset(result.relativePath)).toEqual(JPEG_BYTES);
  });

  it('converts HEIC bytes even when the drag source reports no MIME type', async () => {
    compressImageMock.mockResolvedValue(compressionResult(PNG_BYTES, 'image/png'));

    const result = await service.storeAsset(heicBuffer(), '', documentPath);

    expect(compressImageMock).toHaveBeenCalledWith(expect.any(Buffer), 'image/heic', expect.any(Object));
    expect(result.extension).toBe('png');
  });

  it('hashes the converted bytes so dedup keys off what is on disk', async () => {
    compressImageMock.mockResolvedValue(compressionResult(PNG_BYTES, 'image/png'));

    const heic = heicBuffer();
    const result = await service.storeAsset(heic, 'image/heic', documentPath);

    const crypto = await import('crypto');
    const convertedHash = crypto.createHash('sha256').update(PNG_BYTES).digest('hex');
    const originalHash = crypto.createHash('sha256').update(heic).digest('hex');
    expect(result.hash).toBe(convertedHash);
    expect(result.hash).not.toBe(originalHash);
  });

  it('keeps the honest .heic extension when conversion fails', async () => {
    compressImageMock.mockRejectedValue(new Error('heic decode failed'));

    const result = await service.storeAsset(heicBuffer(), 'image/heic', documentPath);

    expect(result.extension).toBe('heic');
    expect(await readStoredAsset(result.relativePath)).toEqual(heicBuffer());
  });

  it('stores web-renderable images untouched', async () => {
    const result = await service.storeAsset(PNG_BYTES, 'image/png', documentPath);

    expect(compressImageMock).not.toHaveBeenCalled();
    expect(result.extension).toBe('png');
    expect(await readStoredAsset(result.relativePath)).toEqual(PNG_BYTES);
  });

  it('names an unlabeled image from its bytes rather than defaulting to png', async () => {
    const result = await service.storeAsset(JPEG_BYTES, '', documentPath);

    expect(result.extension).toBe('jpg');
  });
});
