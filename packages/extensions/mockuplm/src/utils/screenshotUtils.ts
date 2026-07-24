/**
 * Utilities for capturing mockup screenshots with annotations
 */

/**
 * Capture a composite screenshot of a mockup iframe with optional drawing overlay
 *
 * @param iframe - The iframe element containing the mockup
 * @param drawingCanvas - Optional canvas element with drawing annotations
 * @param drawingPaths - Optional array of drawing paths with absolute coordinates
 * @returns Base64-encoded PNG image data (without data URL prefix)
 */
export async function captureMockupComposite(
  iframe: HTMLIFrameElement,
  drawingCanvas?: HTMLCanvasElement | null,
  drawingPaths?: Array<{ points: { x: number; y: number }[]; color: string }>
): Promise<string> {
  const iframeWindow = iframe.contentWindow;
  const iframeDoc = iframe.contentDocument || iframeWindow?.document;

  if (!iframeDoc || !iframeDoc.body) {
    throw new Error('Cannot access iframe document');
  }

  // Wait for iframe to be fully loaded
  if (iframeDoc.readyState !== 'complete') {
    await new Promise((resolve) => {
      iframeWindow?.addEventListener('load', resolve, { once: true });
      setTimeout(resolve, 5000);
    });
  }

  const iframeWidth = iframe.offsetWidth;
  const iframeHeight = iframe.offsetHeight;

  if (iframeWidth === 0 || iframeHeight === 0) {
    throw new Error(`Iframe has zero dimensions: ${iframeWidth}x${iframeHeight}`);
  }

  // Import html2canvas
  const html2canvas = (await import('html2canvas')).default;

  // Capture the mockup iframe content
  const targetElement = iframeDoc.body;
  const elemWidth = targetElement.scrollWidth || targetElement.offsetWidth || iframeWidth;
  const elemHeight = targetElement.scrollHeight || targetElement.offsetHeight || iframeHeight;

  if (elemWidth === 0 || elemHeight === 0) {
    throw new Error(`Target element has zero dimensions: ${elemWidth}x${elemHeight}`);
  }

  const mockupCanvas = await html2canvas(targetElement, {
    backgroundColor: '#ffffff',
    scale: 2,
    logging: false,
    useCORS: false,
    allowTaint: true,
    foreignObjectRendering: true,
    imageTimeout: 0,
    width: elemWidth,
    height: elemHeight,
    windowWidth: elemWidth,
    windowHeight: elemHeight,
  });

  // Create a new canvas to composite mockup + drawing
  const compositeCanvas = document.createElement('canvas');
  compositeCanvas.width = mockupCanvas.width;
  compositeCanvas.height = mockupCanvas.height;
  const ctx = compositeCanvas.getContext('2d');

  if (!ctx) {
    throw new Error('Failed to get canvas context');
  }

  // Draw mockup
  ctx.drawImage(mockupCanvas, 0, 0);

  // Draw the drawing paths if provided (preferred - uses absolute coordinates)
  if (drawingPaths && drawingPaths.length > 0) {
    // Calculate scale factor (html2canvas uses scale: 2)
    const scale = mockupCanvas.width / elemWidth;

    drawingPaths.forEach(path => {
      if (path.points.length < 2) return;

      ctx.strokeStyle = path.color;
      ctx.lineWidth = 3 * scale;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      ctx.beginPath();
      const firstPoint = path.points[0];
      ctx.moveTo(firstPoint.x * scale, firstPoint.y * scale);

      for (let i = 1; i < path.points.length; i++) {
        const point = path.points[i];
        ctx.lineTo(point.x * scale, point.y * scale);
      }
      ctx.stroke();
    });
  } else if (drawingCanvas) {
    // Fallback: draw canvas overlay (legacy behavior, doesn't handle scroll correctly)
    const scaleX = mockupCanvas.width / drawingCanvas.width;
    const scaleY = mockupCanvas.height / drawingCanvas.height;
    ctx.scale(scaleX, scaleY);
    ctx.drawImage(drawingCanvas, 0, 0);
  }

  // Convert to base64 (strip the data URL prefix)
  const dataUrl = compositeCanvas.toDataURL('image/png');
  const base64Data = dataUrl.replace(/^data:image\/png;base64,/, '');

  return base64Data;
}

/**
 * Convert base64 PNG data to a Blob
 *
 * @param base64Data - Base64-encoded PNG data (without data URL prefix)
 * @returns PNG blob
 */
export function base64ToBlob(base64Data: string): Blob {
  const byteCharacters = atob(base64Data);
  const byteNumbers = new Array(byteCharacters.length);

  for (let i = 0; i < byteCharacters.length; i++) {
    byteNumbers[i] = byteCharacters.charCodeAt(i);
  }

  const byteArray = new Uint8Array(byteNumbers);
  return new Blob([byteArray], { type: 'image/png' });
}
