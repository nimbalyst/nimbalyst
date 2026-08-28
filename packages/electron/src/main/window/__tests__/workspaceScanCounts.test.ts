import { describe, it, expect } from 'vitest';
import {
  formatScannedCount,
  isMarkdownFile,
  summarizeWorkspaceScan,
} from '../workspaceScanCounts';

describe('isMarkdownFile', () => {
  it.each(['README.md', 'docs/guide.md', 'specs/a.markdown'])('accepts %s', p => {
    expect(isMarkdownFile(p)).toBe(true);
  });

  // The control that must go the other way. Without it, a predicate that
  // returned `true` unconditionally would pass every case above.
  it.each(['main.ts', 'notes.txt', 'image.png', 'mdfile', '.mdrc', 'a.md.bak'])(
    'rejects %s',
    p => {
      expect(isMarkdownFile(p)).toBe(false);
    },
  );

  // Pinned deliberately: the two inline copies this replaces were
  // case-sensitive, so preserving that keeps the change from moving any
  // existing count. Changing it is a separate decision.
  it('is case-sensitive, matching the behaviour it replaces', () => {
    expect(isMarkdownFile('README.MD')).toBe(false);
  });
});

describe('formatScannedCount', () => {
  it('returns the plain number when the scan completed', () => {
    expect(formatScannedCount(207, false)).toBe(207);
  });

  it('marks the count as a lower bound when the scan gave up', () => {
    expect(formatScannedCount(16, true)).toBe('16+');
  });

  it('keeps a completed zero distinct from a truncated zero', () => {
    // "0 markdown files" is a fact; "0+ markdown files" means the scan never
    // got far enough to find any. Collapsing them is the #1376 bug in
    // miniature.
    expect(formatScannedCount(0, false)).toBe(0);
    expect(formatScannedCount(0, true)).toBe('0+');
  });
});

describe('summarizeWorkspaceScan (#1376)', () => {
  const files = ['.agents/a.md', '.claude/b.md', 'README.md', 'assets/tex.png', 'src/main.ts'];

  it('reports exact counts for a scan that finished', () => {
    expect(summarizeWorkspaceScan({ files, limited: false })).toEqual({
      fileCount: 5,
      markdownCount: 3,
      limited: false,
    });
  });

  /**
   * The reported bug. The scan stops inside large asset directories that
   * `readdir` returns before `docs/`, so the markdown it found is a floor, not
   * a total. `fileCount` already said so; `markdownCount` did not, and a
   * workspace holding 207 markdown files displayed "16 markdown files".
   */
  it('marks BOTH counts as lower bounds when the scan was truncated', () => {
    expect(summarizeWorkspaceScan({ files, limited: true })).toEqual({
      fileCount: '5+',
      markdownCount: '3+',
      limited: true,
    });
  });

  it('carries the truncation flag through for callers that need it', () => {
    expect(summarizeWorkspaceScan({ files: [], limited: true }).limited).toBe(true);
    expect(summarizeWorkspaceScan({ files: [], limited: false }).limited).toBe(false);
  });

  it('counts no markdown as a truncated zero rather than a confident zero', () => {
    expect(summarizeWorkspaceScan({ files: ['assets/a.png'], limited: true })).toEqual({
      fileCount: '1+',
      markdownCount: '0+',
      limited: true,
    });
  });
});
