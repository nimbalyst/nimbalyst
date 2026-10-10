/**
 * Inline markdown links between pages: `[Acme](../Competitors/Acme.md "id=01J...")`.
 * Images, fenced code blocks and inline code spans are skipped.
 */

export interface MarkdownLink {
  /** Offsets of the whole `[text](dest "title")` in the body. */
  start: number;
  end: number;
  text: string;
  /** Decoded relative path, fragment removed. */
  path: string;
  /** `#section` including the hash, or ''. */
  fragment: string;
  /** Target id from a `"id=..."` title, else null. */
  id: string | null;
  /** True for a relative link to a `.md` file or a folder (`/`), or any link carrying an id. */
  isPageLink: boolean;
}

const LINK = /(!?)\[((?:[^[\]\\\n]|\\.)*)\]\([ \t]*(<[^<>\n]*>|[^\s()<>]*(?:\([^\s()]*\)[^\s()<>]*)*)(?:[ \t]+"((?:[^"\\\n]|\\.)*)")?[ \t]*\)/g;
const ID_TITLE = /^id=([A-Za-z0-9_-]+)$/;

function excludedRanges(body: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let offset = 0;
  let open: { start: number; marker: string } | null = null;
  for (const line of body.split('\n')) {
    const lineEnd = offset + line.length;
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (!open && fence) {
      open = { start: offset, marker: fence[1] };
    } else if (open && fence && fence[1][0] === open.marker[0] && fence[1].length >= open.marker.length && line.trim() === fence[1]) {
      ranges.push([open.start, lineEnd]);
      open = null;
    }
    offset = lineEnd + 1;
  }
  if (open) ranges.push([open.start, body.length]);
  let match: RegExpExecArray | null;
  const inline = /(`+)[^`\n][\s\S]*?\1/g;
  while ((match = inline.exec(body))) {
    const at = match.index;
    if (!ranges.some(([s, e]) => at >= s && at < e)) ranges.push([at, at + match[0].length]);
  }
  return ranges;
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

export function findLinks(body: string): MarkdownLink[] {
  const excluded = excludedRanges(body);
  const out: MarkdownLink[] = [];
  LINK.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = LINK.exec(body))) {
    const start = match.index;
    if (match[1] === '!') continue;
    if (excluded.some(([s, e]) => start >= s && start < e)) continue;
    let rawDest = match[3];
    if (rawDest.startsWith('<')) rawDest = rawDest.slice(1, -1);
    const hash = rawDest.indexOf('#');
    const fragment = hash >= 0 ? rawDest.slice(hash) : '';
    const pathPart = hash >= 0 ? rawDest.slice(0, hash) : rawDest;
    const idMatch = match[4] !== undefined ? ID_TITLE.exec(match[4]) : null;
    const isRelative = pathPart !== '' && !/^[a-z][a-z0-9+.-]*:/i.test(pathPart) && !pathPart.startsWith('/');
    const looksLikePage = isRelative && (/\.md$/i.test(pathPart) || pathPart.endsWith('/'));
    out.push({
      start,
      end: start + match[0].length,
      text: match[2],
      path: safeDecode(pathPart),
      fragment,
      id: idMatch ? idMatch[1] : null,
      isPageLink: looksLikePage || (idMatch !== null && (isRelative || pathPart === '')),
    });
  }
  return out;
}

/** Encodes a relative path for a link destination; spaces and parentheses are escaped. */
export function encodeLinkPath(relPath: string): string {
  return relPath
    .split('/')
    .map((segment) =>
      segment.replace(/[%\s()<>#?"]/g, (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')),
    )
    .join('/');
}

export function formatPageLink(text: string, relPath: string, fragment: string, id: string): string {
  return `[${text}](${encodeLinkPath(relPath)}${fragment} "id=${id}")`;
}

/**
 * Rewrites page links. `replace` gets each page link with its ordinal among
 * the page links in this body and returns the new path and id, or null to
 * leave the link as written.
 */
export function rewriteLinks(
  body: string,
  replace: (link: MarkdownLink, ordinal: number) => { path: string; id: string } | null,
): string {
  const links = findLinks(body).filter((link) => link.isPageLink);
  let out = '';
  let cursor = 0;
  links.forEach((link, ordinal) => {
    const next = replace(link, ordinal);
    if (!next) return;
    const formatted = formatPageLink(link.text, next.path, link.fragment, next.id);
    if (formatted === body.slice(link.start, link.end)) return;
    out += body.slice(cursor, link.start) + formatted;
    cursor = link.end;
  });
  return cursor === 0 ? body : out + body.slice(cursor);
}
