import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  isWorkspaceFileHref,
  openWorkspaceFileLink,
  setWorkspaceFileLinkOpener,
} from '../workspaceLinkNavigation';

describe('isWorkspaceFileHref', () => {
  it('treats a document-relative path as a workspace file link', () => {
    expect(isWorkspaceFileHref('./samples/motor-cradle.replicad.ts')).toBe(true);
  });

  it('treats parent-relative and bare workspace paths as file links', () => {
    expect(isWorkspaceFileHref('../design/plan.md')).toBe(true);
    expect(isWorkspaceFileHref('docs/other-doc.md')).toBe(true);
  });

  it('treats absolute POSIX and Windows drive paths as file links', () => {
    expect(isWorkspaceFileHref('/Users/me/ws/readme.md')).toBe(true);
    expect(isWorkspaceFileHref('C:/ws/readme.md')).toBe(true);
    expect(isWorkspaceFileHref('C:\\ws\\readme.md')).toBe(true);
  });

  it('leaves scheme URLs, anchors, and protocol-relative URLs external', () => {
    expect(isWorkspaceFileHref('https://example.com/a.md')).toBe(false);
    expect(isWorkspaceFileHref('mailto:someone@example.com')).toBe(false);
    expect(isWorkspaceFileHref('collab-asset://org/doc/asset')).toBe(false);
    expect(isWorkspaceFileHref('nimbalyst://NIM-123')).toBe(false);
    expect(isWorkspaceFileHref('#section')).toBe(false);
    expect(isWorkspaceFileHref('//example.com/a.md')).toBe(false);
    expect(isWorkspaceFileHref('')).toBe(false);
    expect(isWorkspaceFileHref(null)).toBe(false);
  });
});

describe('openWorkspaceFileLink', () => {
  afterEach(() => {
    setWorkspaceFileLinkOpener(null);
  });

  it('returns false when no opener is registered', () => {
    expect(openWorkspaceFileLink('./a.md', null)).toBe(false);
  });

  it('routes through the registered opener', () => {
    const opener = vi.fn();
    setWorkspaceFileLinkOpener(opener);
    expect(openWorkspaceFileLink('./a.md', '/ws/docs/readme.md')).toBe(true);
    expect(opener).toHaveBeenCalledWith('./a.md', '/ws/docs/readme.md');
  });
});
