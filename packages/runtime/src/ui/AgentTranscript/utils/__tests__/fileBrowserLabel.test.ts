import { describe, expect, it } from 'vitest';
import { getShowInFileBrowserLabel } from '../fileBrowserLabel';

describe('getShowInFileBrowserLabel', () => {
  it.each([
    ['MacIntel', 'Show in Finder'],
    ['Win32', 'Show in Explorer'],
    ['Linux x86_64', 'Show in Folder'],
    ['', 'Show in Folder'],
  ])('returns the platform-appropriate label for %s', (platform, expectedLabel) => {
    expect(getShowInFileBrowserLabel(platform)).toBe(expectedLabel);
  });
});
