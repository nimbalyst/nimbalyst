import { screenshotService } from '@nimbalyst/extension-sdk';

export function describeScreenshotCaptureError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (
    error &&
    typeof error === 'object' &&
    'type' in error &&
    typeof error.type === 'string'
  ) {
    const target = 'target' in error ? error.target : null;
    const targetTag =
      target &&
      typeof target === 'object' &&
      'tagName' in target &&
      typeof target.tagName === 'string'
        ? target.tagName.toLowerCase()
        : null;
    const subject =
      targetTag === 'img' ? 'Mockup image serialization' : 'Browser capture';
    return `${subject} failed (${error.type} event)`;
  }

  return String(error);
}

/** Capture the visible preview, including its composited annotation overlay.
 * The host captures iframe pixels directly; no iframe DOM access is needed.
 */
export function captureMockupComposite(
  iframe: HTMLIFrameElement
): Promise<string> {
  return screenshotService.captureElement(iframe);
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
