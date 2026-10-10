/**
 * Editing one `key=value` token in a link title without touching the rest of
 * the text: bare words, quoting style, order and unknown keys stay as the
 * author wrote them. Used for web link previews, whose title is kept verbatim
 * (`EmbeddedFileNode.__title`), where re-serializing the parsed attribute map
 * would drop bare tokens and re-quote values.
 *
 * Linear scan; React-free.
 */

interface TitleToken {
  start: number;
  end: number;
  key: string | null;
}

const KEY = /^([A-Za-z_][A-Za-z0-9_-]*)=/;

function tokenize(title: string): TitleToken[] {
  const tokens: TitleToken[] = [];
  let index = 0;
  while (index < title.length) {
    while (index < title.length && /\s/.test(title[index])) index += 1;
    if (index >= title.length) break;
    const start = index;
    while (index < title.length && !/\s/.test(title[index])) {
      const char = title[index];
      if (char === '=' && (title[index + 1] === '"' || title[index + 1] === "'")) {
        const close = title.indexOf(title[index + 1], index + 2);
        index = close === -1 ? title.length : close + 1;
      } else {
        index += 1;
      }
    }
    const text = title.slice(start, index);
    tokens.push({ start, end: index, key: KEY.exec(text)?.[1] ?? null });
  }
  return tokens;
}

function formatPair(key: string, value: string): string {
  if (!/[\s"']/.test(value)) return `${key}=${value}`;
  return value.includes('"') ? `${key}='${value}'` : `${key}="${value}"`;
}

/** The title with `key` set to `value` (replacing the first `key=` token, else appended), or removed when `value` is null. */
export function setTitleAttr(title: string | null | undefined, key: string, value: string | null): string {
  const text = title ?? '';
  const token = tokenize(text).find((candidate) => candidate.key === key);
  if (value === null) {
    if (!token) return text;
    const before = text.slice(0, token.start).replace(/\s+$/, '');
    const after = text.slice(token.end).replace(/^\s+/, '');
    return before && after ? `${before} ${after}` : before || after;
  }
  const pair = formatPair(key, value);
  if (token) return text.slice(0, token.start) + pair + text.slice(token.end);
  const trimmed = text.replace(/\s+$/, '');
  return trimmed ? `${trimmed} ${pair}` : pair;
}

/** A CommonMark `"..."` link title body: backslash and double quote escaped. */
export function escapeLinkTitle(title: string): string {
  return title.replace(/([\\"])/g, '\\$1');
}
