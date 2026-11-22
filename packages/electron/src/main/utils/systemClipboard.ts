/**
 * Main-process clipboard access.
 *
 * Electron 44 removed the synchronous image clipboard API (`writeImage`) and
 * made `readText`/`writeText` return promises. Every main-process clipboard
 * call goes through here so that callers await the write before reporting
 * success, and so the IPC result shapes the renderer relies on stay stable.
 */
import { clipboard, ClipboardItem, nativeImage, type NativeImage } from 'electron';

export type ClipboardResult = { success: true } | { success: false; error: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Resolves once the text is on the system clipboard; rejects if the write fails. */
export async function writeClipboardText(text: string): Promise<void> {
  await clipboard.writeText(text);
}

/** Puts the image on the system clipboard as PNG. */
export async function writeClipboardImage(image: NativeImage): Promise<void> {
  const png = new Uint8Array(image.toPNG());
  await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]);
}

/**
 * Text copy and read keep their pre-44 failure contract: a failed clipboard
 * call rejects the IPC invoke, which is what the renderer helpers surface.
 */
export async function copyTextToClipboard(text: string): Promise<{ success: true }> {
  await writeClipboardText(text);
  return { success: true };
}

export async function copyImageToClipboard(payload: { filePath?: string; dataUrl?: string }): Promise<ClipboardResult> {
  try {
    let image: NativeImage;
    if (payload.filePath) {
      image = nativeImage.createFromPath(payload.filePath);
    } else if (payload.dataUrl) {
      image = nativeImage.createFromDataURL(payload.dataUrl);
    } else {
      return { success: false, error: 'No image source provided' };
    }

    if (image.isEmpty()) {
      return { success: false, error: 'Failed to decode image for clipboard' };
    }

    await writeClipboardImage(image);
    return { success: true };
  } catch (error) {
    console.error('Error copying image to clipboard:', error);
    return { success: false, error: errorMessage(error) };
  }
}

export async function readTextFromClipboard(): Promise<{ success: true; text: string }> {
  return { success: true, text: await clipboard.readText() };
}
