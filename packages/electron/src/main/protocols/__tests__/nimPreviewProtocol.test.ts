import { describe, it, expect } from 'vitest';
import { sep } from 'path';
import {
  encodeNimPreviewUrl,
  validateNimPreviewPath,
  NIM_PREVIEW_SCHEME,
  NIM_PREVIEW_HOST,
} from '../nimPreviewProtocol';

const ROOT = `${sep}tmp${sep}preview-root`;
const OTHER = `${sep}tmp${sep}preview-other`;

describe('nimPreviewProtocol', () => {
  describe('encodeNimPreviewUrl', () => {
    it('produces a parseable nim-preview URL with base64url-encoded root', () => {
      const url = encodeNimPreviewUrl(ROOT, 'site/index.html');
      expect(url).toMatch(
        new RegExp(`^${NIM_PREVIEW_SCHEME}://[A-Za-z0-9_-]+@${NIM_PREVIEW_HOST}/site/index\\.html$`),
      );
    });

    it('URL-encodes each relative-path segment so spaces survive', () => {
      const url = encodeNimPreviewUrl(ROOT, 'site/My Page.html');
      expect(url.endsWith('/site/My%20Page.html')).toBe(true);
    });

    it('drops leading slashes from the relative path', () => {
      const url = encodeNimPreviewUrl(ROOT, '/site/index.html');
      expect(url.endsWith('/site/index.html')).toBe(true);
    });

    it('converts backslash separators to forward slashes', () => {
      const url = encodeNimPreviewUrl(ROOT, 'site\\index.html');
      expect(url.endsWith('/site/index.html')).toBe(true);
    });

    it('preserves the workspace root for root-relative asset URLs', () => {
      const base = encodeNimPreviewUrl(ROOT, 'site/index.html');
      expect(new URL('/app.js', base).href).toMatch(
        new RegExp(`^${NIM_PREVIEW_SCHEME}://[A-Za-z0-9_-]+@${NIM_PREVIEW_HOST}/app\\.js$`),
      );
    });
  });

  describe('validateNimPreviewPath', () => {
    const roots = [ROOT, OTHER];

    it('accepts an HTML file directly under an allowlisted root', () => {
      expect(validateNimPreviewPath(ROOT, 'index.html', roots)).toBe(`${ROOT}${sep}index.html`);
    });

    it('accepts CSS, JS, font, and image assets', () => {
      for (const file of [
        'styles/main.css',
        'app.js',
        'app.mjs',
        'font.woff2',
        'icon.svg',
        'img/hero.webp',
      ]) {
        expect(validateNimPreviewPath(ROOT, file, roots)).not.toBeNull();
      }
    });

    it('accepts nested asset paths', () => {
      const result = validateNimPreviewPath(ROOT, 'deeply/nested/page/index.html', roots);
      expect(result).toBe(`${ROOT}${sep}deeply${sep}nested${sep}page${sep}index.html`);
    });

    it('rejects when no roots are configured', () => {
      expect(validateNimPreviewPath(ROOT, 'index.html', [])).toBeNull();
    });

    it('rejects when the requested root is not on the allowlist', () => {
      expect(validateNimPreviewPath(`${sep}etc`, 'passwd.html', roots)).toBeNull();
    });

    it('rejects .. traversal', () => {
      expect(validateNimPreviewPath(ROOT, '../escape.html', roots)).toBeNull();
    });

    it('rejects .. traversal with backslash separators', () => {
      expect(validateNimPreviewPath(ROOT, '..\\escape.html', roots)).toBeNull();
    });

    it('rejects null bytes in the workspace root', () => {
      expect(validateNimPreviewPath(`${ROOT}\0`, 'index.html', roots)).toBeNull();
    });

    it('rejects null bytes in the relative path', () => {
      expect(validateNimPreviewPath(ROOT, 'index.html\0', roots)).toBeNull();
    });

    it('rejects extensions outside the preview allowlist', () => {
      // Project metadata that an attacker might want to exfiltrate.
      expect(validateNimPreviewPath(ROOT, 'package.json', roots)).toBeNull();
      expect(validateNimPreviewPath(ROOT, 'secret.txt', roots)).toBeNull();
      expect(validateNimPreviewPath(ROOT, 'app.ts', roots)).toBeNull();
      expect(validateNimPreviewPath(ROOT, 'README.md', roots)).toBeNull();
    });

    it('rejects an empty relative path', () => {
      expect(validateNimPreviewPath(ROOT, '', roots)).toBeNull();
    });

    it('case-insensitive extension matching', () => {
      expect(validateNimPreviewPath(ROOT, 'INDEX.HTML', roots)).not.toBeNull();
    });

    it('requires directory-boundary prefix match (no substring prefix)', () => {
      // /tmp/preview-root-evil must NOT match the /tmp/preview-root allowlist.
      const result = validateNimPreviewPath(`${ROOT}-evil`, 'index.html', roots);
      expect(result).toBeNull();
    });
  });
});
