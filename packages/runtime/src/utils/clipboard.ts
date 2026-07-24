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
