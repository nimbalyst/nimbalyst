import { describe, expect, it, vi } from 'vitest';
import { MAX_MESSAGE_ATTACHMENT_BYTES } from '@nimbalyst/collab-protocol';

import {
  AttachmentError,
  boundedFileName,
  formatByteSize,
  preflightAttachment,
  renameForMimeType,
  uploadConversationAttachment,
  type UploadAssetResult,
} from '../conversationAttachments';

const TARGET = { orgId: 'org-1', conversationId: 'conversation-1' };

/** jsdom's Blob predates `arrayBuffer()`; Chromium's has had it for years. */
function withArrayBuffer<T extends Blob>(blob: T): T {
  if (typeof blob.arrayBuffer !== 'function') {
    Object.defineProperty(blob, 'arrayBuffer', {
      value: async () => new ArrayBuffer(8),
    });
  }
  return blob;
}

function fileOf(name: string, type: string, size: number): File {
  // A real Blob of 12 MB would make this suite slow for no gain: the code under
  // test reads `size` and `type`, and reads the bytes only after it decides to.
  const file = new File([new Uint8Array(Math.min(size, 8))], name, { type });
  Object.defineProperty(file, 'size', { value: size });
  return withArrayBuffer(file);
}

function okUpload(): {
  uploadAsset: (payload: {
    orgId: string;
    documentId: string;
    fileBytes: ArrayBuffer;
    mimeType: string;
    fileName: string;
  }) => Promise<UploadAssetResult>;
} {
  return {
    uploadAsset: vi.fn(async () => ({
      success: true,
      assetId: 'asset-1',
      uri: 'collab-asset://doc/conversation-1/asset/asset-1',
    })),
  };
}

describe('conversation attachments', () => {
  describe('pre-flight', () => {
    it('rejects an oversize non-image before anything reads it', () => {
      const result = preflightAttachment({
        name: 'capture.mov',
        type: 'video/quicktime',
        size: MAX_MESSAGE_ATTACHMENT_BYTES + 1,
      });

      expect(result).toMatchObject({ ok: false, code: 'tooLarge' });
      expect(result.ok === false && result.message).toContain('10.0 MB');
    });

    it('lets an oversize screenshot through so it can be compressed', () => {
      expect(
        preflightAttachment({
          name: 'screenshot.png',
          type: 'image/png',
          size: MAX_MESSAGE_ATTACHMENT_BYTES + 1,
        }),
      ).toEqual({ ok: true, mayReencode: true });
    });

    it('refuses to re-encode a GIF, so an oversize one is simply too large', () => {
      // Round-tripping a GIF through a canvas keeps one frame and drops the
      // animation. Refusing is honest; silently de-animating is not.
      expect(
        preflightAttachment({
          name: 'loop.gif',
          type: 'image/gif',
          size: MAX_MESSAGE_ATTACHMENT_BYTES + 1,
        }),
      ).toMatchObject({ ok: false, code: 'tooLarge' });
    });

    it('rejects an empty file', () => {
      expect(
        preflightAttachment({ name: 'nothing.txt', type: 'text/plain', size: 0 }),
      ).toMatchObject({ ok: false, code: 'empty' });
    });

    it('accepts an in-bounds file of any type', () => {
      expect(
        preflightAttachment({
          name: 'report.pdf',
          type: 'application/pdf',
          size: 1024,
        }),
      ).toEqual({ ok: true, mayReencode: false });
    });
  });

  describe('upload', () => {
    it('uploads an in-bounds file against the conversation id', async () => {
      const deps = okUpload();

      const attachment = await uploadConversationAttachment(
        TARGET,
        fileOf('report.pdf', 'application/pdf', 2048),
        { ...deps, prepareImage: async () => null },
      );

      expect(deps.uploadAsset).toHaveBeenCalledWith(
        expect.objectContaining({
          orgId: 'org-1',
          documentId: 'conversation-1',
          mimeType: 'application/pdf',
          fileName: 'report.pdf',
        }),
      );
      expect(attachment).toEqual({
        assetId: 'asset-1',
        fileName: 'report.pdf',
        mimeType: 'application/pdf',
        byteSize: 2048,
      });
    });

    it('reports the compressed size and dimensions of a re-encoded image', async () => {
      const compressed = withArrayBuffer(
        new Blob([new Uint8Array(4096)], { type: 'image/jpeg' }),
      );
      const deps = okUpload();

      const attachment = await uploadConversationAttachment(
        TARGET,
        fileOf('Screenshot 2026.png', 'image/png', MAX_MESSAGE_ATTACHMENT_BYTES + 1),
        {
          ...deps,
          prepareImage: async () => ({
            blob: compressed,
            mimeType: 'image/jpeg',
            width: 1920,
            height: 1080,
          }),
        },
      );

      expect(attachment).toEqual({
        assetId: 'asset-1',
        // The name has to stop claiming PNG once the bytes are JPEG.
        fileName: 'Screenshot 2026.jpg',
        mimeType: 'image/jpeg',
        byteSize: 4096,
        width: 1920,
        height: 1080,
      });
    });

    it('refuses an image that is still too large after compression', async () => {
      const stillHuge = new Blob([new Uint8Array(8)], { type: 'image/jpeg' });
      Object.defineProperty(stillHuge, 'size', {
        value: MAX_MESSAGE_ATTACHMENT_BYTES + 1,
      });
      const deps = okUpload();

      await expect(
        uploadConversationAttachment(
          TARGET,
          fileOf('huge.png', 'image/png', MAX_MESSAGE_ATTACHMENT_BYTES * 2),
          {
            ...deps,
            prepareImage: async () => ({
              blob: stillHuge,
              mimeType: 'image/jpeg',
              width: 1920,
              height: 1080,
            }),
          },
        ),
      ).rejects.toMatchObject({
        code: 'tooLarge',
        message: expect.stringContaining('after compression'),
      });
      expect(deps.uploadAsset).not.toHaveBeenCalled();
    });

    it('turns the storage-budget failure into an actionable sentence', async () => {
      await expect(
        uploadConversationAttachment(
          TARGET,
          fileOf('report.pdf', 'application/pdf', 2048),
          {
            prepareImage: async () => null,
            uploadAsset: async () => {
              throw new Error(
                "Error invoking remote method 'document-sync:upload-asset': Error: COLLAB_ASSET_STORAGE_BUDGET_EXCEEDED",
              );
            },
          },
        ),
      ).rejects.toMatchObject({
        code: 'storageBudget',
        message: expect.stringContaining('Out of local space'),
      });
    });

    it('surfaces a failed upload result as an attachment error', async () => {
      const failure = uploadConversationAttachment(
        TARGET,
        fileOf('report.pdf', 'application/pdf', 2048),
        {
          prepareImage: async () => null,
          uploadAsset: async () => ({
            success: false,
            error: 'Document not open in this window',
          }),
        },
      );

      await expect(failure).rejects.toBeInstanceOf(AttachmentError);
      await expect(failure).rejects.toMatchObject({ code: 'uploadFailed' });
    });
  });

  describe('naming', () => {
    it('keeps a bounded name unchanged', () => {
      expect(boundedFileName('notes.md')).toBe('notes.md');
    });

    it('truncates a long name but keeps its extension', () => {
      const bounded = boundedFileName(`${'a'.repeat(400)}.png`);

      expect(bounded).toHaveLength(255);
      expect(bounded.endsWith('.png')).toBe(true);
    });

    it('leaves a non-image name alone when the type has no extension', () => {
      expect(renameForMimeType('report.pdf', 'application/pdf')).toBe('report.pdf');
    });

    it('formats sizes the way the composer shows them', () => {
      expect(formatByteSize(512)).toBe('512 B');
      expect(formatByteSize(2048)).toBe('2 KB');
      expect(formatByteSize(10 * 1024 * 1024)).toBe('10.0 MB');
    });
  });
});
