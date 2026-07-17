import { describe, it, expect } from 'vitest';
import { encodeMarkdownLinkPath } from '../markdownLink';

describe('encodeMarkdownLinkPath', () => {
  it('encodes spaces so the destination is not truncated (GH #693 / NIM-964)', () => {
    const encoded = encodeMarkdownLinkPath('/D:/My Project/mockups/design.mockup.html');
    expect(encoded).toBe('/D:/My%20Project/mockups/design.mockup.html');
    // Round-trips back to the real path the way the transcript/file-open
    // resolvers decode it.
    expect(decodeURIComponent(encoded)).toBe('/D:/My Project/mockups/design.mockup.html');
  });

  it('leaves clean paths (path separators, drive colon) untouched', () => {
    expect(encodeMarkdownLinkPath('/Users/me/notes/plan.md')).toBe('/Users/me/notes/plan.md');
    expect(encodeMarkdownLinkPath('C:/work/file.ts')).toBe('C:/work/file.ts');
  });

  it('encodes parentheses (e.g. "Program Files (x86)") and round-trips', () => {
    const encoded = encodeMarkdownLinkPath('C:/Program Files (x86)/App/notes file.md');
    expect(encoded).toBe('C:/Program%20Files%20%28x86%29/App/notes%20file.md');
    expect(decodeURIComponent(encoded)).toBe('C:/Program Files (x86)/App/notes file.md');
  });

  it('encodes literal percent signs first so encoding is lossless', () => {
    const encoded = encodeMarkdownLinkPath('/tmp/50% done/file.md');
    expect(decodeURIComponent(encoded)).toBe('/tmp/50% done/file.md');
  });
});
