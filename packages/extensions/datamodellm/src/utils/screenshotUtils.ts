/**
 * Screenshot utilities for DatamodelLM
 *
 * Captures the data model canvas as a PNG image.
 */

import { screenshotService } from '@nimbalyst/extension-sdk';

/**
 * Capture the data model canvas as a base64-encoded PNG
 *
 * @param canvasElement - The React Flow canvas container element
 * @returns Base64-encoded PNG image data (without data URL prefix)
 */
export async function captureDataModelCanvas(
  canvasElement: HTMLElement
): Promise<string> {
  return screenshotService.captureElement(canvasElement);
}

/**
 * Download a screenshot as a PNG file
 *
 * @param base64Data - Base64-encoded PNG data
 * @param filename - Name for the downloaded file (without extension)
 */
export function downloadScreenshot(base64Data: string, filename: string): void {
  const link = document.createElement('a');
  link.href = `data:image/png;base64,${base64Data}`;
  link.download = `${filename}.png`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

/**
 * Copy screenshot to clipboard
 *
 * @param base64Data - Base64-encoded PNG data
 */
export async function copyScreenshotToClipboard(base64Data: string): Promise<void> {
  // Convert base64 to blob
  const byteCharacters = atob(base64Data);
  const byteNumbers = new Array(byteCharacters.length);
  for (let i = 0; i < byteCharacters.length; i++) {
    byteNumbers[i] = byteCharacters.charCodeAt(i);
  }
  const byteArray = new Uint8Array(byteNumbers);
  const blob = new Blob([byteArray], { type: 'image/png' });

  // Copy to clipboard
  await navigator.clipboard.write([
    new ClipboardItem({ 'image/png': blob }),
  ]);
}
