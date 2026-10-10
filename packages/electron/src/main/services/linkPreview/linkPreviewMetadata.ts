/**
 * Preview metadata from a page's HTML: Open Graph first, then Twitter card
 * tags, then plain `<title>` / `<meta name="description">` / `<link rel=icon>`.
 *
 * The input is hostile by assumption, and this runs on main's thread, so the
 * scanner is a single forward pass with no backtracking regex: every index
 * advances, each tag and attribute is length-capped, and scanning stops at
 * `</head>`, `<body>` or `MAX_SCAN_BYTES`. Nothing here executes markup or
 * resolves anything but URLs.
 *
 * Page images (`og:image`) are not used: the card shows a favicon only, which
 * the service fetches through its own protected path.
 *
 * The shape mirrors the runtime's `LinkPreviewMetadata`; this crosses IPC as
 * plain JSON.
 */

export interface LinkPreviewMetadata {
  url: string;
  finalUrl?: string;
  title?: string;
  description?: string;
  siteName?: string;
  /** Not produced; kept for the cache shape of older entries. */
  image?: string;
  /** A `data:` URL once the service has fetched it; the parser returns the page URL. */
  favicon?: string;
}

const MAX_TEXT = 300;
const MAX_SCAN_BYTES = 128 * 1024;
const MAX_TAG = 4096;
const MAX_ATTR_NAME = 64;
const MAX_ATTR_VALUE = 2048;
const MAX_TITLE = 2048;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'",
  mdash: '\u2014', ndash: '\u2013', hellip: '\u2026', rsquo: '\u2019', lsquo: '\u2018', rdquo: '\u201d', ldquo: '\u201c',
};

export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z0-9]{1,10});/gi, (whole, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith('#x')) return safeCodePoint(parseInt(lower.slice(2), 16), whole);
    if (lower.startsWith('#')) return safeCodePoint(parseInt(lower.slice(1), 10), whole);
    return NAMED_ENTITIES[lower] ?? whole;
  });
}

function safeCodePoint(code: number, fallback: string): string {
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return fallback;
  return String.fromCodePoint(code);
}

function clean(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const value = decodeHtmlEntities(text.slice(0, MAX_ATTR_VALUE)).replace(/\s+/g, ' ').trim();
  if (!value) return undefined;
  return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT - 1)}\u2026` : value;
}

function isSpace(char: string): boolean {
  return char === ' ' || char === '\n' || char === '\t' || char === '\r' || char === '\f';
}

function isNameChar(char: string): boolean {
  return /[A-Za-z0-9:_.-]/.test(char);
}

/**
 * Attributes of one tag body (between the name and `>`), lowercased names.
 * One pass over `body`, which the caller has capped at `MAX_TAG`.
 */
function readAttributes(body: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  let index = 0;
  while (index < body.length) {
    while (index < body.length && (isSpace(body[index]) || body[index] === '/')) index += 1;
    const nameStart = index;
    while (index < body.length && !isSpace(body[index]) && body[index] !== '=' && body[index] !== '/') index += 1;
    const name = body.slice(nameStart, index).toLowerCase();
    while (index < body.length && isSpace(body[index])) index += 1;
    let value = '';
    if (body[index] === '=') {
      index += 1;
      while (index < body.length && isSpace(body[index])) index += 1;
      const quote = body[index];
      if (quote === '"' || quote === "'") {
        const close = body.indexOf(quote, index + 1);
        const end = close === -1 ? body.length : close;
        value = body.slice(index + 1, end);
        index = end + 1;
      } else {
        const valueStart = index;
        while (index < body.length && !isSpace(body[index])) index += 1;
        value = body.slice(valueStart, index);
      }
    }
    if (name && name.length <= MAX_ATTR_NAME && !(name in attrs)) attrs[name] = value.slice(0, MAX_ATTR_VALUE);
    if (index === nameStart) index += 1;
  }
  return attrs;
}

/** End of the tag starting at `from` (index of its `>`), quote-aware, or -1 within `MAX_TAG`. */
function findTagEnd(html: string, from: number, limit: number): number {
  let quote: string | null = null;
  for (let index = from; index < limit; index += 1) {
    const char = html[index];
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '>') {
      return index;
    }
  }
  return -1;
}

interface HeadTags {
  meta: Map<string, string>;
  links: Array<Record<string, string>>;
  title?: string;
}

/** One forward pass over the head. Linear in the scanned length. */
export function scanHead(html: string): HeadTags {
  const source = html.length > MAX_SCAN_BYTES ? html.slice(0, MAX_SCAN_BYTES) : html;
  const lower = source.toLowerCase();
  const result: HeadTags = { meta: new Map(), links: [] };
  let index = 0;
  while (index < source.length) {
    const open = lower.indexOf('<', index);
    if (open === -1) break;
    if (lower.startsWith('<!--', open)) {
      const close = lower.indexOf('-->', open + 4);
      if (close === -1) break;
      index = close + 3;
      continue;
    }
    if (lower.startsWith('</head', open) || lower.startsWith('<body', open)) break;
    let nameEnd = open + 1;
    while (nameEnd < source.length && nameEnd - open <= 16 && isNameChar(source[nameEnd])) nameEnd += 1;
    const name = lower.slice(open + 1, nameEnd);
    if (!name) {
      index = open + 1;
      continue;
    }
    const tagEnd = findTagEnd(source, nameEnd, Math.min(source.length, open + MAX_TAG));
    if (tagEnd === -1) {
      // Oversized or unterminated: skip the whole window, never rescan it.
      index = Math.min(source.length, open + MAX_TAG);
      continue;
    }
    index = tagEnd + 1;
    if (name === 'meta') {
      const attrs = readAttributes(source.slice(nameEnd, tagEnd));
      const key = (attrs.property ?? attrs.name ?? attrs.itemprop ?? '').toLowerCase();
      if (key && attrs.content !== undefined && !result.meta.has(key)) result.meta.set(key, attrs.content);
    } else if (name === 'link') {
      if (result.links.length < 32) result.links.push(readAttributes(source.slice(nameEnd, tagEnd)));
    } else if (name === 'title' || name === 'script' || name === 'style' || name === 'noscript' || name === 'template') {
      const close = lower.indexOf(`</${name}`, index);
      const end = close === -1 ? source.length : close;
      if (name === 'title' && result.title === undefined) result.title = source.slice(index, Math.min(end, index + MAX_TITLE));
      index = end;
    }
  }
  return result;
}

/** An absolute http(s) URL for `raw` relative to `base`, or undefined. */
export function resolveHttpUrl(raw: string | undefined, base: string): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(decodeHtmlEntities(raw.trim()), base);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function parseLinkPreviewHtml(html: string, requestedUrl: string, finalUrl: string = requestedUrl): LinkPreviewMetadata {
  const { meta, links, title: titleTag } = scanHead(html);

  let favicon: string | undefined;
  for (const attrs of links) {
    const rel = (attrs.rel ?? '').toLowerCase().split(/\s+/);
    if (!rel.includes('icon') && !rel.includes('apple-touch-icon')) continue;
    const href = resolveHttpUrl(attrs.href, finalUrl);
    // Prefer the plain icon over the touch icon when a page lists both.
    if (href && (!favicon || rel.includes('icon'))) favicon = href;
    if (favicon && rel.includes('icon')) break;
  }

  let origin = '';
  try {
    origin = new URL(finalUrl).origin;
  } catch {
    // finalUrl was validated by the fetcher; leave the favicon fallback off.
  }

  const result: LinkPreviewMetadata = { url: requestedUrl };
  if (finalUrl !== requestedUrl) result.finalUrl = finalUrl;
  const title = clean(meta.get('og:title') ?? meta.get('twitter:title') ?? titleTag);
  const description = clean(meta.get('og:description') ?? meta.get('twitter:description') ?? meta.get('description'));
  const siteName = clean(meta.get('og:site_name') ?? meta.get('application-name'));
  const icon = favicon ?? (origin ? `${origin}/favicon.ico` : undefined);
  if (title) result.title = title;
  if (description) result.description = description;
  if (siteName) result.siteName = siteName;
  if (icon) result.favicon = icon;
  return result;
}
