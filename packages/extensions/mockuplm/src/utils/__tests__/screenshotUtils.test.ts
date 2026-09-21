import { describe, expect, it } from 'vitest';
import {
  describeScreenshotCaptureError,
} from '../screenshotUtils';

describe('describeScreenshotCaptureError', () => {
  it('turns a raw image error event into an actionable message', () => {
    const image = document.createElement('img');
    let imageError: Event | undefined;
    image.addEventListener('error', (event) => {
      imageError = event;
    });
    image.dispatchEvent(new Event('error'));

    expect(describeScreenshotCaptureError(imageError)).toBe(
      'Mockup image serialization failed (error event)'
    );
  });
});
