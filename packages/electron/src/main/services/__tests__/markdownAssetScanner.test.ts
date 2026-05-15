import { describe, it, expect } from 'vitest';
import * as path from 'path';
import {
  scanMarkdownImageRefs,
  resolveAssetRef,
  rewriteMarkdownImageRefs,
} from '../markdownAssetScanner';

const WORKSPACE = '/workspace';
const DOC_PATH = '/workspace/docs/spec.md';

describe('markdownAssetScanner', () => {
  describe('scanMarkdownImageRefs', () => {
    it('extracts a single image ref from markdown', () => {
      const md = 'before\n\n![alt](assets/abc.png)\n\nafter';
      expect(scanMarkdownImageRefs(md)).toEqual(['assets/abc.png']);
    });

    it('preserves document order across multiple refs', () => {
      const md = '![a](one.png) text ![b](two.gif)';
      expect(scanMarkdownImageRefs(md)).toEqual(['one.png', 'two.gif']);
    });

    it('deduplicates repeated refs', () => {
      const md = '![a](x.png) and again ![b](x.png) and ![c](y.png)';
      expect(scanMarkdownImageRefs(md)).toEqual(['x.png', 'y.png']);
    });

    it('ignores non-image links', () => {
      // Plain links must not be picked up -- non-image local refs are out of scope.
      const md = '[notes](assets/notes.md) and ![img](assets/img.png)';
      expect(scanMarkdownImageRefs(md)).toEqual(['assets/img.png']);
    });

    it('ignores refs with whitespace (markdown title attrs disqualify them)', () => {
      // The minimal regex only matches refs without whitespace; an image with a
      // title attribute `![alt](url "title")` is left untouched by this pass.
      // This matches the behavior of storeAsset() output which never includes
      // title attrs on pasted images.
      const md = '![alt](assets/img.png "title")';
      expect(scanMarkdownImageRefs(md)).toEqual([]);
    });
  });

  describe('resolveAssetRef', () => {
    it('resolves a doc-relative assets/ ref', () => {
      const result = resolveAssetRef('assets/abc.png', DOC_PATH, WORKSPACE);
      expect(result).toEqual({
        kind: 'resolved',
        ref: 'assets/abc.png',
        absolutePath: path.join('/workspace/docs', 'assets/abc.png'),
        mimeType: 'image/png',
        fileName: 'abc.png',
      });
    });

    it('resolves a workspace-level .nimbalyst/assets/ ref', () => {
      const result = resolveAssetRef('.nimbalyst/assets/abc.jpg', DOC_PATH, WORKSPACE);
      expect(result).toEqual({
        kind: 'resolved',
        ref: '.nimbalyst/assets/abc.jpg',
        absolutePath: path.join(WORKSPACE, '.nimbalyst/assets/abc.jpg'),
        mimeType: 'image/jpeg',
        fileName: 'abc.jpg',
      });
    });

    it('resolves an absolute file:// ref inside the workspace', () => {
      const absUrl = `file://${WORKSPACE}/docs/img.webp`;
      const result = resolveAssetRef(absUrl, DOC_PATH, WORKSPACE);
      expect(result.kind).toBe('resolved');
      if (result.kind !== 'resolved') return;
      expect(result.absolutePath).toBe(`${WORKSPACE}/docs/img.webp`);
      expect(result.mimeType).toBe('image/webp');
    });

    it('rejects a file:// ref outside the workspace (path traversal)', () => {
      const absUrl = 'file:///etc/passwd';
      const result = resolveAssetRef(absUrl, DOC_PATH, WORKSPACE);
      expect(result).toEqual({
        kind: 'rejected',
        ref: absUrl,
        reason: 'path traversal: outside workspace',
      });
    });

    it('rejects an assets/ ref that escapes the workspace via ../', () => {
      const result = resolveAssetRef(
        'assets/../../../../etc/passwd.png',
        DOC_PATH,
        WORKSPACE,
      );
      expect(result.kind).toBe('rejected');
    });

    it('skips http and data and blob and collab-asset refs', () => {
      for (const ref of [
        'https://example.com/img.png',
        'http://example.com/img.png',
        'data:image/png;base64,XXXX',
        'blob:http://localhost/abc',
        'collab-asset://doc/abc/asset/xyz',
      ]) {
        const result = resolveAssetRef(ref, DOC_PATH, WORKSPACE);
        expect(result.kind, `expected skip for ${ref}`).toBe('skip');
      }
    });

    it('skips a non-image extension under assets/', () => {
      const result = resolveAssetRef('assets/notes.txt', DOC_PATH, WORKSPACE);
      expect(result.kind).toBe('skip');
    });

    it('skips refs that are not under assets/ or .nimbalyst/assets/', () => {
      const result = resolveAssetRef('./notes.txt', DOC_PATH, WORKSPACE);
      expect(result.kind).toBe('skip');
    });
  });

  describe('rewriteMarkdownImageRefs', () => {
    it('replaces every occurrence of substituted refs', () => {
      const md =
        '![a](x.png) and ![b](x.png) and ![c](y.png) and ![d](z.png)';
      const substitutions = new Map([
        ['x.png', 'collab-asset://doc/d/asset/x'],
        ['y.png', 'collab-asset://doc/d/asset/y'],
      ]);
      const out = rewriteMarkdownImageRefs(md, substitutions);
      expect(out).toBe(
        '![a](collab-asset://doc/d/asset/x) and ![b](collab-asset://doc/d/asset/x) and ![c](collab-asset://doc/d/asset/y) and ![d](z.png)',
      );
    });

    it('leaves unsubstituted refs and non-image links untouched', () => {
      const md = '![a](unknown.png) and [link](other.png)';
      const out = rewriteMarkdownImageRefs(md, new Map());
      expect(out).toBe(md);
    });
  });
});
