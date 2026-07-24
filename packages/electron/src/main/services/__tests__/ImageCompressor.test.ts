import Module from 'module';
import { afterEach, describe, expect, it, vi } from 'vitest';

const TEST_PNG_BUFFER = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ImageCompressor', () => {
  it('does not load the HEIC decoder stack for non-HEIC images', async () => {
    const moduleRequireSpy = vi.spyOn(Module.prototype, 'require');
    const { compressImage } = await import('../ImageCompressor');

    const result = await compressImage(TEST_PNG_BUFFER, 'image/png');

    expect(result.mimeType).toBe('image/png');
    expect(moduleRequireSpy).not.toHaveBeenCalledWith('heic-decode');
  });
});
