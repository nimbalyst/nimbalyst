/**
 * Conversation attachments.
 *
 * The bytes take the same encrypted path a shared document's images take --
 * durable outbox in main, `PUT /api/collab/docs/{id}/assets/{assetId}`,
 * `collab-asset://` for reads -- with the conversation id standing in for the
 * document id. Nothing here is messaging-specific except the bounds.
 *
 * Two things happen before an upload, in this order, and the order is the
 * point:
 *
 *   1. A large screenshot is re-encoded down to something sendable. A Retina
 *      capture is routinely 8-15 MB of PNG for a picture of some text; sending
 *      that verbatim wastes the recipient's bandwidth as much as the author's.
 *   2. The size bound is applied to whatever came out of step 1, and to the
 *      original file BEFORE it is read when step 1 cannot help it.
 *
 * That second clause is why the guard lives here and not in the IPC handler:
 * a 400 MB video should be refused without ever being read into memory.
 */

import {
  MAX_MESSAGE_ATTACHMENT_BYTES,
  MAX_MESSAGE_ATTACHMENT_FILE_NAME_LENGTH,
  type MessageAttachment,
} from '@nimbalyst/collab-protocol';

import { MAX_COLLAB_ASSET_BYTES } from '../../shared/collabAssetFormat';

/** Longest edge a re-encoded image keeps. Above this it is scaled down. */
export const ATTACHMENT_MAX_IMAGE_EDGE = 1920;

/** JPEG quality for a re-encoded image with no transparency to preserve. */
const REENCODE_QUALITY = 0.85;

/**
 * Formats this module may re-encode.
 *
 * GIF is absent on purpose -- a canvas round trip keeps the first frame and
 * silently discards the animation, which is worse than refusing an oversize
 * file. SVG is absent because it is not raster and has no size problem to fix.
 */
const REENCODABLE_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
]);

export type AttachmentErrorCode =
  | 'empty'
  | 'tooLarge'
  | 'storageBudget'
  | 'uploadFailed';

/** A refusal the composer can show verbatim. Never a raw IPC error string. */
export class AttachmentError extends Error {
  constructor(
    readonly code: AttachmentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AttachmentError';
  }
}

export interface ConversationAttachmentTarget {
  orgId: string;
  conversationId: string;
}

/** What a decoded/re-encoded image contributes to the upload. */
export interface PreparedImage {
  blob: Blob;
  mimeType: string;
  width: number;
  height: number;
}

export interface UploadAssetResult {
  success: boolean;
  assetId?: string;
  uri?: string;
  error?: string;
  errorCode?: string;
}

export interface AttachmentUploadDeps {
  /** Returns null when the file is not a raster image this module re-encodes. */
  prepareImage?: (file: File, maxEdge: number) => Promise<PreparedImage | null>;
  uploadAsset?: (payload: {
    orgId: string;
    documentId: string;
    fileBytes: ArrayBuffer;
    mimeType: string;
    fileName: string;
  }) => Promise<UploadAssetResult>;
}

export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The pre-flight decision, separated from every browser API so it can be
 * reasoned about (and tested) without a canvas.
 *
 * `mayReencode` is what buys an oversize image a second chance: it is allowed
 * past the messaging bound here because the re-encode is expected to bring it
 * under, and the bound is re-applied to the result.
 */
export function preflightAttachment(file: {
  name: string;
  size: number;
  type: string;
}):
  | { ok: true; mayReencode: boolean }
  | { ok: false; code: AttachmentErrorCode; message: string } {
  if (file.size === 0) {
    return {
      ok: false,
      code: 'empty',
      message: `${file.name} is empty.`,
    };
  }

  const mayReencode = REENCODABLE_IMAGE_TYPES.has(file.type);
  // Even a re-encodable image has a ceiling: decoding an arbitrarily large
  // bitmap is itself the denial of service.
  const ceiling = mayReencode ? MAX_COLLAB_ASSET_BYTES : MAX_MESSAGE_ATTACHMENT_BYTES;
  if (file.size > ceiling) {
    return {
      ok: false,
      code: 'tooLarge',
      message: `${file.name} is ${formatByteSize(file.size)}. Attachments are limited to ${formatByteSize(MAX_MESSAGE_ATTACHMENT_BYTES)}.`,
    };
  }

  return { ok: true, mayReencode };
}

/**
 * Keep a name inside the protocol bound without losing the extension, which is
 * the part a reader uses to know what they are about to open.
 */
export function boundedFileName(name: string): string {
  const trimmed = name.trim() || 'attachment';
  if (trimmed.length <= MAX_MESSAGE_ATTACHMENT_FILE_NAME_LENGTH) return trimmed;
  const dot = trimmed.lastIndexOf('.');
  const extension = dot > 0 ? trimmed.slice(dot, dot + 16) : '';
  return (
    trimmed.slice(0, MAX_MESSAGE_ATTACHMENT_FILE_NAME_LENGTH - extension.length)
    + extension
  );
}

/** `screenshot.png` re-encoded as JPEG must not still claim to be a PNG. */
export function renameForMimeType(name: string, mimeType: string): string {
  const extension = mimeType === 'image/jpeg'
    ? '.jpg'
    : mimeType === 'image/png'
      ? '.png'
      : mimeType === 'image/webp'
        ? '.webp'
        : null;
  if (!extension) return name;
  if (name.toLowerCase().endsWith(extension)) return name;
  const dot = name.lastIndexOf('.');
  return `${dot > 0 ? name.slice(0, dot) : name}${extension}`;
}

export async function uploadConversationAttachment(
  target: ConversationAttachmentTarget,
  file: File,
  deps: AttachmentUploadDeps = {},
): Promise<MessageAttachment> {
  const preflight = preflightAttachment(file);
  if (!preflight.ok) throw new AttachmentError(preflight.code, preflight.message);

  const prepare = deps.prepareImage ?? prepareImageForUpload;
  const prepared = preflight.mayReencode
    ? await prepare(file, ATTACHMENT_MAX_IMAGE_EDGE)
    : null;

  const blob: Blob = prepared?.blob ?? file;
  const mimeType = prepared?.mimeType ?? file.type ?? 'application/octet-stream';
  if (blob.size > MAX_MESSAGE_ATTACHMENT_BYTES) {
    throw new AttachmentError(
      'tooLarge',
      `${file.name} is ${formatByteSize(blob.size)} after compression. Attachments are limited to ${formatByteSize(MAX_MESSAGE_ATTACHMENT_BYTES)}.`,
    );
  }

  const fileName = boundedFileName(
    prepared ? renameForMimeType(file.name, mimeType) : file.name,
  );
  const upload = deps.uploadAsset
    ?? ((payload) => window.electronAPI.documentSync.uploadAsset(payload));

  // Read after the bound is settled, never before: that ordering is the guard.
  const fileBytes = await blob.arrayBuffer();
  let result: UploadAssetResult;
  try {
    result = await upload({
      orgId: target.orgId,
      documentId: target.conversationId,
      fileBytes,
      mimeType,
      fileName,
    });
  } catch (error) {
    throw toAttachmentError(error, fileName);
  }
  if (!result.success || !result.assetId) {
    throw toAttachmentError(new Error(result.error ?? ''), fileName);
  }

  return {
    assetId: result.assetId,
    fileName,
    mimeType,
    byteSize: blob.size,
    ...(prepared ? { width: prepared.width, height: prepared.height } : {}),
  };
}

/**
 * Local upload storage is a fixed per-account budget, so "out of space" is a
 * real and recoverable state rather than an internal error. It gets its own
 * sentence, because "upload failed" would leave the author with nothing to do.
 */
function toAttachmentError(error: unknown, fileName: string): AttachmentError {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (message.includes('COLLAB_ASSET_STORAGE_BUDGET_EXCEEDED')) {
    return new AttachmentError(
      'storageBudget',
      'Out of local space for pending uploads. Wait for earlier attachments to finish sending, then try again.',
    );
  }
  return new AttachmentError(
    'uploadFailed',
    message.trim().length > 0
      ? `${fileName} could not be attached: ${message}`
      : `${fileName} could not be attached.`,
  );
}

/**
 * Decode, and re-encode only when there is a reason to.
 *
 * Alpha is measured rather than assumed: a screenshot is a PNG and almost
 * never transparent, so encoding it as JPEG is the whole saving -- but a logo
 * or a cropped cutout is transparent, and flattening it onto black is a
 * visible defect. Sampling the decoded pixels is the only way to tell.
 *
 * Returns null when the image cannot be decoded here; the caller then uploads
 * the original bytes, which is always correct and never smaller.
 */
async function prepareImageForUpload(
  file: File,
  maxEdge: number,
): Promise<PreparedImage | null> {
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') {
    return null;
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return null;
  }

  const longest = Math.max(bitmap.width, bitmap.height);
  const scale = longest > maxEdge ? maxEdge / longest : 1;
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const fits = file.size <= MAX_MESSAGE_ATTACHMENT_BYTES;

  // In bounds at its natural size: keep the author's exact bytes. Dimensions
  // are still reported, so the reader can lay the image out before it loads.
  if (scale === 1 && fits) {
    bitmap.close?.();
    return {
      blob: file,
      mimeType: file.type,
      width,
      height,
    };
  }

  try {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return fallbackPrepared(file, width, height, fits);
    context.drawImage(bitmap, 0, 0, width, height);

    const mimeType = canvasHasTransparency(context, width, height)
      ? 'image/png'
      : 'image/jpeg';
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, mimeType, REENCODE_QUALITY);
    });
    if (!blob) return fallbackPrepared(file, width, height, fits);
    // Re-encoding a small, already-optimal image can make it bigger. Only keep
    // the new bytes when they are actually an improvement.
    if (blob.size >= file.size && fits) {
      return { blob: file, mimeType: file.type, width, height };
    }
    return { blob, mimeType, width, height };
  } finally {
    bitmap.close?.();
  }
}

function fallbackPrepared(
  file: File,
  width: number,
  height: number,
  fits: boolean,
): PreparedImage | null {
  // Without a working canvas there is nothing to send but the original, and
  // an oversize original has to fail the bound rather than slip past it.
  return fits ? { blob: file, mimeType: file.type, width, height } : null;
}

function canvasHasTransparency(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
): boolean {
  let pixels: Uint8ClampedArray;
  try {
    pixels = context.getImageData(0, 0, width, height).data;
  } catch {
    // Reading back can fail (tainted canvas); assume transparency and keep PNG
    // rather than risk flattening it.
    return true;
  }
  for (let index = 3; index < pixels.length; index += 4) {
    if (pixels[index] < 255) return true;
  }
  return false;
}
