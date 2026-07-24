import { describe, it, expect } from 'vitest';
import { sep } from 'path';
import {
  encodeNimPreviewUrl,
  validateNimPreviewPath,
  previewPathsEqual,
  previewPathInsideRoot,
  NIM_PREVIEW_SCHEME,
  NIM_PREVIEW_HOST,
} from '../nimPreviewProtocol';

const ROOT = `${sep}tmp${sep}preview-root`;
const OTHER = `${sep}tmp${sep}preview-other`;

describe('nimPreviewProtocol', () => {
  describe('encodeNimPreviewUrl', () => {
    const hexRoot = Buffer.from(ROOT, 'utf8').toString('hex');

    // Issue #612: the URL must NOT carry the root in the username (Electron's
    // protocol.handle strips credentials and partitioned sessions refuse
    // credentialed navigations) and must NOT be base64url (URL hosts are
    // lowercased by the canonicalizer). Lowercase hex in the host means the
    // page origin itself carries the root.
    it('produces a credential-free URL with the lowercase-hex root as host', () => {
      const url = encodeNimPreviewUrl(ROOT, 'site/index.html');
      expect(url).toBe(`${NIM_PREVIEW_SCHEME}://${hexRoot}/site/index.html`);
      expect(url).not.toContain('@');
      expect(hexRoot).toMatch(/^[0-9a-f]+$/);
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

    it('preserves the workspace root for page-relative asset URLs', () => {
      const base = encodeNimPreviewUrl(ROOT, 'site/index.html');
      expect(new URL('app.js', base).href).toBe(
        `${NIM_PREVIEW_SCHEME}://${hexRoot}/site/app.js`,
      );
    });

    it('preserves the workspace root for root-relative asset URLs', () => {
      const base = encodeNimPreviewUrl(ROOT, 'site/index.html');
      expect(new URL('/app.js', base).href).toBe(
        `${NIM_PREVIEW_SCHEME}://${hexRoot}/app.js`,
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

  // Issue #612: Windows compares paths case-insensitively (drive-letter and
  // directory casing vary between path sources), so the comparison helpers
  // take a caseInsensitive flag that defaults to process.platform === 'win32'.
  // The flag is passed explicitly here so the win32 semantics are exercised
  // on any host platform.
  describe('case-insensitive path comparison (win32 semantics)', () => {
    it('previewPathsEqual matches differing drive/directory casing when case-insensitive', () => {
      expect(previewPathsEqual(`${sep}Tmp${sep}Root`, `${sep}tmp${sep}root`, true)).toBe(true);
      expect(previewPathsEqual(`${sep}Tmp${sep}Root`, `${sep}tmp${sep}root`, false)).toBe(false);
    });

    it('previewPathInsideRoot matches a file under a differently-cased root when case-insensitive', () => {
      const root = `${sep}Tmp${sep}Preview-Root`;
      const file = `${sep}tmp${sep}preview-root${sep}site${sep}index.html`;
      expect(previewPathInsideRoot(root, file, true)).toBe(true);
      expect(previewPathInsideRoot(root, file, false)).toBe(false);
    });

    it('previewPathInsideRoot treats the root itself as inside', () => {
      expect(previewPathInsideRoot(ROOT, ROOT, true)).toBe(true);
      expect(previewPathInsideRoot(ROOT, ROOT, false)).toBe(true);
    });

    it('previewPathInsideRoot still rejects sibling substring prefixes case-insensitively', () => {
      expect(previewPathInsideRoot(ROOT, `${ROOT}-EVIL${sep}index.html`, true)).toBe(false);
    });
  });
});
