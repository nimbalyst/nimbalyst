/**
 * The HTML each exported page carries before the app loads: the page as plain
 * HTML, so it reads without JavaScript and a crawler sees its text and links.
 * When the app boots it replaces all of it with the real read-only editor, so
 * this only has to be legible, not faithful: rich blocks (charts, diagrams,
 * decisions) show their source as code, and raw HTML in a body is left out,
 * except colored text, which keeps its colors.
 *
 * Links are relative to the page's folder, so this fallback works wherever
 * the site is hosted.
 */
import { Marked, type Tokens } from 'marked';
import { encodeLinkPath, type LocalPage, type StaticSiteConfig } from '@nimbalyst/local-wiki';
import { formatTextColorStyle, parseTextColorOpenTag } from '@nimbalyst/runtime/core/textColorSyntax';
import { linkBase, resolveRelative } from './bodyLinks.js';

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const SAFE_SCHEME = /^(https?|mailto):/i;

export interface PrerenderSite {
  pages: ReadonlyMap<string, LocalPage>;
  included: ReadonlySet<string>;
  /** Id to site path, as in the manifest. */
  sitePaths: Readonly<Record<string, string>>;
  basePath: string;
}

/** Site-relative URL of a page from a page at `fromSitePath`. */
export function pageHref(prefix: string, sitePath: string): string {
  return sitePath ? `${prefix}${sitePath.split('/').map(encodeURIComponent).join('/')}/` : prefix;
}

function findTarget(site: PrerenderSite, target: string, folder: boolean): LocalPage | null {
  const key = target.toLowerCase();
  for (const page of site.pages.values()) {
    if (!site.included.has(page.id)) continue;
    if (!folder && page.path?.toLowerCase() === key) return page;
    if (page.dir.toLowerCase() === key && (folder || !page.path)) return page;
  }
  return null;
}

/** Where a link or image in `page` points on the site; null when it should not be a link. */
function siteUrl(site: PrerenderSite, page: Pick<LocalPage, 'path' | 'dir'>, prefix: string, href: string): string | null {
  const raw = href.trim();
  if (raw.startsWith('#')) return raw;
  // A site path the exporter wrote (`/items/<id>/`, a carried tracker item), made relative to this page.
  if (raw.startsWith(site.basePath) && !raw.startsWith('//')) return `${prefix}${raw.slice(site.basePath.length)}`;
  if (SCHEME.test(raw)) return SAFE_SCHEME.test(raw) ? raw : null;
  const hash = raw.indexOf('#');
  const bare = hash >= 0 ? raw.slice(0, hash) : raw;
  let decoded = bare.replace(/\?.*$/, '');
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // As written.
  }
  const target = resolveRelative(linkBase(page), decoded);
  if (target === null) return null;
  const linked = /\.md$/i.test(target) || bare.endsWith('/') ? findTarget(site, target, bare.endsWith('/')) : findTarget(site, target, false);
  if (linked) return pageHref(prefix, site.sitePaths[linked.id] ?? '');
  return `${prefix}_wiki/files/${encodeLinkPath(target)}`;
}

const SPAN_OPEN = /^<span\b[^>]*>$/i;
const SPAN_CLOSE = /^<\/span\s*>$/i;

export function renderBodyHtml(markdown: string, page: Pick<LocalPage, 'path' | 'dir'>, site: PrerenderSite, prefix: string): string {
  // Whether each open inline `<span>` was written, so its `</span>` is written or dropped with it.
  const openSpans: boolean[] = [];
  const marked = new Marked({
    gfm: true,
    async: false,
    renderer: {
      link(this: { parser: { parseInline(tokens: Tokens.Generic[]): string } }, token: Tokens.Link) {
        const label = this.parser.parseInline(token.tokens);
        const url = siteUrl(site, page, prefix, token.href);
        return url === null ? label : `<a href="${escapeHtml(url)}">${label}</a>`;
      },
      image(token: Tokens.Image) {
        const url = siteUrl(site, page, prefix, token.href);
        return url === null ? escapeHtml(token.text) : `<img src="${escapeHtml(url)}" alt="${escapeHtml(token.text)}" loading="lazy">`;
      },
      // Columns, tabs and other HTML-backed blocks: their markdown inside still renders, the tags do not.
      // Colored text is drawn from its parsed colors only, never from the tag as written.
      html(token: Tokens.HTML | Tokens.Tag) {
        if (token.block) return '';
        const tag = token.text.trim();
        if (SPAN_OPEN.test(tag)) {
          const style = parseTextColorOpenTag(tag);
          openSpans.push(style !== null);
          return style ? `<span style="${escapeHtml(formatTextColorStyle(style))}">` : '';
        }
        if (SPAN_CLOSE.test(tag)) return openSpans.pop() ? '</span>' : '';
        return '';
      },
    },
  });
  // `> [!NOTE] Title` reads as a labelled quote; the app draws the real callout.
  const callouts = markdown.replace(/^(\s*>\s*)\[!(\w+)\][ \t]*(.*)$/gm, (_line, quote: string, kind: string, title: string) => {
    const label = kind.charAt(0).toUpperCase() + kind.slice(1).toLowerCase();
    return `${quote}**${label}${title ? `: ${title}` : ''}**`;
  });
  return marked.parse(callouts) as string;
}

/** The first paragraph's text, for the page's description meta tag. */
export function describe(markdown: string): string {
  for (const block of markdown.split(/\n\s*\n/)) {
    const text = block
      .replace(/^```[\s\S]*$/m, '')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]+>/g, '')
      .replace(/^\s*(?:#{1,6}|[-*+]|\d+\.|>)\s+/gm, '')
      .replace(/[*_`]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (text && !text.startsWith('```')) return text.length > 200 ? `${text.slice(0, 197)}...` : text;
  }
  return '';
}

export interface ShellPage {
  /** Site path of this HTML file's folder; '' for the root. */
  sitePath: string;
  title: string;
  description: string;
  /** Prerendered content placed in the app's root element. */
  content: string;
}

/** Turns the app's built `index.html` into one exported page. */
export function renderShell(template: string, wikiTitle: string, page: ShellPage, config: StaticSiteConfig): string {
  const fullTitle = page.title && page.title !== wikiTitle ? `${page.title} · ${wikiTitle}` : wikiTitle;
  const head = [
    `<meta name="description" content="${escapeHtml(page.description)}" />`,
    `<meta property="og:title" content="${escapeHtml(page.title || wikiTitle)}" />`,
    `<meta property="og:description" content="${escapeHtml(page.description)}" />`,
    `<meta property="og:site_name" content="${escapeHtml(wikiTitle)}" />`,
    `<style>${PRERENDER_CSS}</style>`,
    // Read by the app before it loads any data; `<` is escaped so no value can close the tag.
    `<script>window.__NIMBALYST_WIKI_STATIC__=${JSON.stringify(config).replace(/</g, '\\u003c')}</script>`,
  ].join('\n    ');
  // Rebase only the app template, before adding the page's relative links.
  let html = template.replace(/\b(src|href)=(['"])\/(?!\/)([^'"]*)\2/g,
    (_match, attr: string, quote: string, url: string) => `${attr}=${quote}${escapeHtml(config.basePath ?? '/')}${url}${quote}`);
  html = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${escapeHtml(fullTitle)}</title>`);
  html = html.replace('</head>', `    ${head}\n  </head>`);
  html = html.replace('<div id="root"></div>', `<div id="root">${page.content}</div>`);
  return html;
}

/** Enough to read a prerendered page; the app's own styles take over once it loads. */
const PRERENDER_CSS = [
  '.wiki-static-prerender{display:flex;gap:32px;max-width:1100px;margin:0 auto;padding:24px;font:15px/1.6 system-ui,-apple-system,sans-serif;color:#1f2328}',
  '.wiki-static-nav{flex:0 0 220px;font-size:13px}',
  '.wiki-static-nav ul{list-style:none;margin:0;padding-left:12px}',
  '.wiki-static-nav>ul{padding-left:0}',
  '.wiki-static-article{flex:1;min-width:0}',
  '.wiki-static-article pre{overflow:auto;padding:12px;background:#f6f8fa;border-radius:6px}',
  '.wiki-static-article table{border-collapse:collapse}',
  '.wiki-static-article td,.wiki-static-article th{border:1px solid #d0d7de;padding:4px 8px}',
  '.wiki-static-article img{max-width:100%}',
  '.wiki-static-nav .wiki-static-made-with{display:inline-flex;align-items:center;gap:6px;margin-top:16px;font-size:12px;color:#59636e;text-decoration:none}',
  '.wiki-static-fields{font-size:13px;color:#59636e}',
  '@media (max-width:700px){.wiki-static-prerender{flex-direction:column}}',
].join('');
