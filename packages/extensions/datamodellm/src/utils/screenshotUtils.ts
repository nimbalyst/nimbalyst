/**
 * Screenshot utilities for DatamodelLM
 *
 * Captures the data model canvas as a PNG image.
 */

import html2canvas from 'html2canvas';

/**
 * Capture the data model canvas as a base64-encoded PNG
 *
 * @param canvasElement - The React Flow canvas container element
 * @returns Base64-encoded PNG image data (without data URL prefix)
 */
export async function captureDataModelCanvas(
  canvasElement: HTMLElement
): Promise<string> {
  // Find the React Flow viewport element
  const viewport = canvasElement.querySelector('.react-flow__viewport') as HTMLElement;
  if (!viewport) {
    throw new Error('Could not find React Flow viewport');
  }

  const width = canvasElement.offsetWidth;
  const height = canvasElement.offsetHeight;

  if (width === 0 || height === 0) {
    throw new Error(`Canvas has zero dimensions: ${width}x${height}`);
  }

  // Capture the canvas
  const canvas = await html2canvas(canvasElement, {
    backgroundColor: null, // Preserve transparency
    scale: 2, // Higher resolution
    logging: false,
    useCORS: false,
    allowTaint: true,
    foreignObjectRendering: true,
    imageTimeout: 0,
    width,
    height,
    windowWidth: width,
    windowHeight: height,
  });

  // Convert to base64 (strip the data URL prefix)
  const dataUrl = canvas.toDataURL('image/png');
  const base64Data = dataUrl.replace(/^data:image\/png;base64,/, '');

  return base64Data;
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
