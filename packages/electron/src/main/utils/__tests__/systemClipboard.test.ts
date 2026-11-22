// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => {
  class FakeClipboardItem {
    constructor(readonly items: Record<string, unknown>) {}
  }
  return {
    clipboard: {
      write: vi.fn<(items: unknown[]) => Promise<void>>(),
      writeText: vi.fn<(text: string) => Promise<void>>(),
      readText: vi.fn<() => Promise<string>>(),
    },
    ClipboardItem: FakeClipboardItem,
    nativeImage: {
      createFromPath: vi.fn(),
      createFromDataURL: vi.fn(),
    },
  };
});

vi.mock('electron', () => electron);

import { copyImageToClipboard, copyTextToClipboard, readTextFromClipboard } from '../systemClipboard';

const pngBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const fakeImage = (empty = false) => ({ isEmpty: () => empty, toPNG: () => Buffer.from(pngBytes) });

beforeEach(() => {
  vi.clearAllMocks();
  electron.clipboard.write.mockResolvedValue(undefined);
  electron.clipboard.writeText.mockResolvedValue(undefined);
});

describe('systemClipboard', () => {
  it('writes images as a single PNG ClipboardItem carrying the encoded bytes', async () => {
    electron.nativeImage.createFromDataURL.mockReturnValue(fakeImage());

    await expect(copyImageToClipboard({ dataUrl: 'data:image/png;base64,AAAA' })).resolves.toEqual({ success: true });

    expect(electron.clipboard.write).toHaveBeenCalledOnce();
    const [items] = electron.clipboard.write.mock.calls[0];
    expect(items).toHaveLength(1);
    const blob = (items[0] as InstanceType<typeof electron.ClipboardItem>).items['image/png'] as Blob;
    expect(blob.type).toBe('image/png');
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(pngBytes);
  });

  it('reports an image write rejection as a failed result instead of success', async () => {
    electron.nativeImage.createFromPath.mockReturnValue(fakeImage());
    electron.clipboard.write.mockRejectedValue(new Error('pasteboard unavailable'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(copyImageToClipboard({ filePath: '/tmp/a.png' })).resolves.toEqual({
      success: false,
      error: 'pasteboard unavailable',
    });
  });

  it('does not touch the clipboard for an undecodable image', async () => {
    electron.nativeImage.createFromPath.mockReturnValue(fakeImage(true));

    await expect(copyImageToClipboard({ filePath: '/tmp/broken.png' })).resolves.toEqual({
      success: false,
      error: 'Failed to decode image for clipboard',
    });
    expect(electron.clipboard.write).not.toHaveBeenCalled();
  });

  it('acknowledges a text copy only after the async write settles, and propagates its rejection', async () => {
    let finishWrite!: () => void;
    electron.clipboard.writeText.mockReturnValue(new Promise<void>((resolve) => { finishWrite = resolve; }));
    let settled = false;
    const pending = copyTextToClipboard('hello').then((result) => { settled = true; return result; });
    await Promise.resolve();
    expect(settled).toBe(false);
    finishWrite();
    await expect(pending).resolves.toEqual({ success: true });

    electron.clipboard.writeText.mockRejectedValue(new Error('denied'));
    await expect(copyTextToClipboard('hello')).rejects.toThrow('denied');
  });

  it('returns the resolved clipboard text, not a promise, in the IPC result', async () => {
    electron.clipboard.readText.mockResolvedValue('pasted text');
    await expect(readTextFromClipboard()).resolves.toEqual({ success: true, text: 'pasted text' });
  });
});
