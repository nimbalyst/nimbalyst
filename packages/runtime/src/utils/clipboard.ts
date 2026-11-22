/**
 * Clipboard utilities that route through Electron's native clipboard via IPC.
 *
 * navigator.clipboard can silently fail in Electron - the promise resolves but
 * nothing is written to the system clipboard. These helpers use Electron's
 * native clipboard module via IPC when available, falling back to the web API
 * for non-Electron contexts.
 */
export async function copyToClipboard(text: string): Promise<void> {
  // Prefer Electron's native clipboard (always works, no focus requirement)
  const electronAPI = (window as any).electronAPI;
  if (electronAPI?.copyToClipboard) {
    await electronAPI.copyToClipboard(text);
    return;
  }

  // Fallback for non-Electron contexts
  await navigator.clipboard.writeText(text);
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read blob'));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });
}

async function resolveImageDataUrl(src: string): Promise<string> {
  if (src.startsWith('data:')) {
    return src;
  }

  const response = await fetch(src);
  if (!response.ok) {
    throw new Error(`Failed to fetch image: ${response.status}`);
  }

  return blobToDataUrl(await response.blob());
}

export async function copyImageToClipboard(options: { src: string; filePath?: string }): Promise<void> {
  const electronAPI = (window as any).electronAPI;
  if (electronAPI?.copyImageToClipboard) {
    const dataUrl = options.filePath ? undefined : await resolveImageDataUrl(options.src);
    await electronAPI.copyImageToClipboard({
      filePath: options.filePath,
      dataUrl,
    });
    return;
  }

  const response = await fetch(options.src);
  if (!response.ok) {
    throw new Error(`Failed to fetch image: ${response.status}`);
  }

  const blob = await response.blob();
  if (typeof ClipboardItem === 'undefined') {
    throw new Error('Image clipboard is not supported in this environment');
  }

  await navigator.clipboard.write([
    new ClipboardItem({
      [blob.type || 'image/png']: blob,
    }),
  ]);
}

export async function readClipboard(): Promise<string> {
  const electronAPI = (window as any).electronAPI;
  if (electronAPI?.readClipboard) {
    const result = await electronAPI.readClipboard();
    return result.text ?? '';
  }

  // Fallback for non-Electron contexts
  return navigator.clipboard.readText();
}

/**
 * True when a paste carries no files and no text. Under WSL this is how an
 * image copied in Windows arrives: WSLg passes only text to Linux apps, so the
 * paste holds an empty text entry and no image.
 */
export function isEmptyPaste(data: Pick<DataTransfer, 'files' | 'getData'>): boolean {
  return data.files.length === 0 && !data.getData('text/plain') && !data.getData('text/html');
}

/**
 * The image on the Windows clipboard, read by the host when it runs under WSL,
 * as the File a browser paste would give. Null off WSL, outside Electron, or
 * when Windows holds no image.
 */
export async function readWindowsClipboardImage(): Promise<File | null> {
  const electronAPI = (window as any).electronAPI;
  if (!electronAPI?.readWindowsClipboardImage) return null;
  try {
    const image: { mimeType: string; data: Uint8Array<ArrayBuffer> } | null = await electronAPI.readWindowsClipboardImage();
    return image ? new File([image.data], 'image.png', { type: image.mimeType }) : null;
  } catch (error) {
    console.warn('[clipboard] Could not read the Windows clipboard image', error);
    return null;
  }
}
