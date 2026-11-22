/**
 * Interactive HTML pages in the browser view. An `.html` page renders in the
 * HTML embed sandbox (the shell `nim wiki serve` serves at
 * `WIKI_HTML_EMBED_SHELL_URL` with its sandbox CSP); its editor is a preview
 * with a source toggle. Not a pinned extension: like the canvas, it is the
 * app's own type, declared here with the same id the desktop records.
 */
import { useEffect, useState } from 'react';
import type { BrowserExtensionManifest } from '@nimbalyst/web-editors/registry';
import { HTML_PAGE_DEFAULT_CONTENT } from '@nimbalyst/runtime-source/ui/htmlEmbed/htmlPageCodec';
import { readHtmlEmbedTheme } from '@nimbalyst/runtime-source/ui/htmlEmbed/htmlEmbedTheme';
import type { HtmlEmbedTheme } from '@nimbalyst/runtime-source/ui/htmlEmbed/htmlEmbedProtocol';
import type { HtmlEmbedNavigateOptions } from '@nimbalyst/runtime-source/ui/htmlEmbed/HtmlEmbedFrame';
import { currentTheme, onThemeChange } from '../../theme';
import { isStaticSite, staticBasePath } from '../../api/staticSite';

// A static host serves a folder's index.html for the trailing-slash path; `nim wiki export` writes the shell there.
export const WIKI_HTML_EMBED_SHELL_URL = isStaticSite() ? `${staticBasePath}html-embed/shell/` : '/html-embed/shell';

export const HTML_PAGE_MANIFEST: BrowserExtensionManifest = {
  id: 'builtin.html',
  name: 'HTML page',
  contributions: {
    customEditors: [{ filePatterns: ['*.html'], displayName: 'HTML page', component: 'HtmlPageEditor' }],
    newFileMenu: [{ extension: '.html', displayName: 'HTML page', icon: 'html', defaultContent: HTML_PAGE_DEFAULT_CONTENT }],
    fileIcons: { '*.html': 'html' },
  },
  marketplace: { icon: 'html' },
};

/** The app's theme for an embed, following the system setting live. */
export function useWikiHtmlEmbedTheme(): HtmlEmbedTheme {
  const [theme, setTheme] = useState(() => readHtmlEmbedTheme(currentTheme()));
  useEffect(() => onThemeChange((next) => setTheme(readHtmlEmbedTheme(next))), []);
  return theme;
}

type Navigator = (fromPageId: string | null, href: string, options: HtmlEmbedNavigateOptions) => void;

let navigator: Navigator | null = null;

/** The app installs how a link clicked inside an HTML page opens; `fromPageId` null means the open page. */
export function setWikiHtmlNavigator(next: Navigator | null): void {
  navigator = next;
}

export function navigateFromHtml(fromPageId: string | null, href: string, options: HtmlEmbedNavigateOptions): void {
  navigator?.(fromPageId, href, options);
}
