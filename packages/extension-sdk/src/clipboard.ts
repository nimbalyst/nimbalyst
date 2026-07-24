/**
 * Clipboard utilities for Nimbalyst extensions.
 *
 * Routes through Electron's native clipboard via IPC when available,
 * falling back to the standard navigator.clipboard Web API for
 * non-Electron contexts.
 *
 * navigator.clipboard.writeText() can silently fail in Electron -- the
 * promise resolves but nothing is written to the system clipboard.
 * These helpers avoid that issue by using the IPC bridge.
 */

export async function copyToClipboard(text: string): Promise<void> {
  const electronAPI = (window as any).electronAPI;
  if (electronAPI?.copyToClipboard) {
    await electronAPI.copyToClipboard(text);
    return;
  }
  await navigator.clipboard.writeText(text);
}

export async function readClipboard(): Promise<string> {
  const electronAPI = (window as any).electronAPI;
  if (electronAPI?.readClipboard) {
    const result = await electronAPI.readClipboard();
    return result.text ?? '';
  }
  return navigator.clipboard.readText();
}
