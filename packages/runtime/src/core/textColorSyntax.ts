/**
 * Markdown syntax for colored text: an inline HTML span whose `style` holds
 * only `color` and/or `background-color`, the form Obsidian renders.
 *
 *   <span style="color: #f03e3e">**Blocked** on review</span>
 *   <span style="background-color: #ffd43b4d">needs a look</span>
 *   <span style="color: #228be6; background-color: #adb5bd4d">both</span>
 *
 * The span's content is ordinary inline markdown (emphasis, links and code
 * nest inside it). A span with any other attribute or style property is not
 * colored text and stays literal.
 *
 * The toolbar writes a fixed palette. A palette value is drawn through a
 * `--nim-text-color-*` / `--nim-text-bg-*` theme variable so it adapts to the
 * theme; any other value (from Obsidian or written by hand) is drawn as
 * written and saved back byte for byte.
 *
 * Pure: no Lexical, React or DOM. Used by the editor node and transformer,
 * the transcript renderer and the wiki browser views.
 */

export type TextColorName = 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple' | 'gray';

export type TextColorKind = 'color' | 'background';

export interface TextColorSwatch {
  name: TextColorName;
  label: string;
  /** Hex written for text color. At least 3:1 on white and on dark backgrounds, so it reads anywhere the file is opened. */
  color: string;
  /** Hex with alpha written for background color, so default text stays readable over it in light and dark themes. */
  background: string;
}

export const TEXT_COLOR_PALETTE: readonly TextColorSwatch[] = [
  { name: 'red', label: 'Red', color: '#f03e3e', background: '#ff6b6b40' },
  { name: 'orange', label: 'Orange', color: '#e8590c', background: '#ff922b40' },
  { name: 'yellow', label: 'Yellow', color: '#d97706', background: '#ffd43b4d' },
  { name: 'green', label: 'Green', color: '#2f9e44', background: '#51cf6640' },
  { name: 'blue', label: 'Blue', color: '#228be6', background: '#4dabf740' },
  { name: 'purple', label: 'Purple', color: '#845ef7', background: '#9775fa40' },
  { name: 'gray', label: 'Gray', color: '#868e96', background: '#adb5bd4d' },
];

export interface TextColorStyle {
  color?: string;
  backgroundColor?: string;
}

/** One colored span found in a line of markdown. */
export interface InlineColorSpan {
  /** Offset of `<span`. */
  start: number;
  /** Offset just past the matching `</span>`. */
  end: number;
  innerStart: number;
  innerEnd: number;
  /** The opening tag as written, kept so an unchanged span is saved byte for byte. */
  openTag: string;
  style: TextColorStyle;
}

const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
// Color functions with plain numeric arguments only: no nested parentheses,
// quotes, semicolons or backslashes, so nothing like `url(` can get through.
const COLOR_FUNCTION = /^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\([\d\s.,%/+\-a-z]*\)$/i;
const NAMED_COLOR = /^[a-z]+$/i;

/** True for a CSS color value that is safe to put in a `style` attribute. */
export function isSafeCssColor(value: string): boolean {
  return HEX_COLOR.test(value) || COLOR_FUNCTION.test(value) || NAMED_COLOR.test(value);
}

/**
 * Parse a `style` attribute value. Returns null unless it declares only
 * `color` and/or `background-color` with safe values.
 */
export function parseTextColorStyle(styleText: string): TextColorStyle | null {
  const style: TextColorStyle = {};
  for (const declaration of styleText.split(';')) {
    if (declaration.trim() === '') continue;
    const colon = declaration.indexOf(':');
    if (colon === -1) return null;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration.slice(colon + 1).trim();
    if (!isSafeCssColor(value)) return null;
    if (property === 'color') style.color = value;
    else if (property === 'background-color') style.backgroundColor = value;
    else return null;
  }
  return style.color !== undefined || style.backgroundColor !== undefined ? style : null;
}

export function formatTextColorStyle(style: TextColorStyle): string {
  const parts: string[] = [];
  if (style.color) parts.push(`color: ${style.color}`);
  if (style.backgroundColor) parts.push(`background-color: ${style.backgroundColor}`);
  return parts.join('; ');
}

export function sameTextColorStyle(a: TextColorStyle, b: TextColorStyle): boolean {
  return (a.color ?? '') === (b.color ?? '') && (a.backgroundColor ?? '') === (b.backgroundColor ?? '');
}

/**
 * Write a colored span. The opening tag as it was read is reused while it
 * still parses to the same colors, so `style='color:red'` is not rewritten.
 */
export function formatTextColorSpan(inner: string, style: TextColorStyle, rawOpenTag?: string): string {
  if (rawOpenTag) {
    const rawStyle = parseTextColorOpenTag(rawOpenTag);
    if (rawStyle && sameTextColorStyle(rawStyle, style)) return `${rawOpenTag}${inner}</span>`;
  }
  return `<span style="${formatTextColorStyle(style)}">${inner}</span>`;
}

const OPEN_TAG = /<span\s+style\s*=\s*(?:"([^"]*)"|'([^']*)')\s*>/gi;
const WHOLE_OPEN_TAG = /^<span\s+style\s*=\s*(?:"([^"]*)"|'([^']*)')\s*>$/i;
const SPAN_TAG_AT = /<span\b[^>]*>|<\/span\s*>/y;

/** The colors of a whole `<span style="...">` opening tag, or null when it is not a colored-text tag. */
export function parseTextColorOpenTag(tag: string): TextColorStyle | null {
  const match = WHOLE_OPEN_TAG.exec(tag);
  return match ? parseTextColorStyle(match[1] ?? match[2] ?? '') : null;
}

/**
 * Find the first colored span at or after `from` whose closing tag balances.
 * Nested spans (colored or not) are counted so the outer one closes on its own
 * `</span>`. An escaped `\<span` is not a tag.
 */
export function findInlineColorSpan(text: string, from = 0): InlineColorSpan | null {
  OPEN_TAG.lastIndex = from;
  let open: RegExpExecArray | null;
  while ((open = OPEN_TAG.exec(text)) !== null) {
    const start = open.index;
    const style = text[start - 1] === '\\' ? null : parseTextColorStyle(open[1] ?? open[2] ?? '');
    const innerStart = start + open[0].length;
    if (style) {
      const close = findClosingSpan(text, innerStart);
      if (close && close.start > innerStart) {
        OPEN_TAG.lastIndex = 0;
        return { start, end: close.end, innerStart, innerEnd: close.start, openTag: open[0], style };
      }
    }
    OPEN_TAG.lastIndex = start + 1;
  }
  OPEN_TAG.lastIndex = 0;
  return null;
}

/**
 * The `</span>` that closes a span opened before `from`. Tags inside inline
 * code and backslash-escaped tags are text, as the markdown reads them.
 */
function findClosingSpan(text: string, from: number): { start: number; end: number } | null {
  let depth = 1;
  let i = from;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '`') {
      i = skipCodeSpan(text, i);
      continue;
    }
    if (ch === '<') {
      SPAN_TAG_AT.lastIndex = i;
      const tag = SPAN_TAG_AT.exec(text);
      if (tag) {
        depth += tag[0][1] === '/' ? -1 : 1;
        if (depth === 0) return { start: i, end: i + tag[0].length };
        i += tag[0].length;
        continue;
      }
    }
    i += 1;
  }
  return null;
}

/** Offset just past the code span whose opening backtick run starts at `at`, or past the run when it never closes. */
function skipCodeSpan(text: string, at: number): number {
  let runEnd = at;
  while (text[runEnd] === '`') runEnd += 1;
  const fence = runEnd - at;
  let i = runEnd;
  while (i < text.length) {
    if (text[i] !== '`') {
      i += 1;
      continue;
    }
    let end = i;
    while (text[end] === '`') end += 1;
    if (end - i === fence) return end;
    i = end;
  }
  return runEnd;
}

/**
 * Escape the opening tags in literal text that would read back as colored
 * spans, so text shown as `<span style="color:teal">x</span>` stays text
 * after a save. `following` is the text after it in the same block: a tag is
 * only escaped when its `</span>` is there, so an unclosed one keeps its bytes.
 */
export function escapeColorSpanOpenTags(text: string, following = ''): string {
  if (!/<span/i.test(text)) return text;
  const all = text + following;
  const escapeAt: number[] = [];
  let from = 0;
  let span: InlineColorSpan | null;
  while ((span = findInlineColorSpan(all, from)) !== null && span.start < text.length) {
    escapeAt.push(span.start);
    from = span.start + 1;
  }
  return insertEscapes(text, escapeAt);
}

/**
 * Escape span tags in literal text inside a colored span that are not
 * balanced within the text itself: an unmatched `</span>` would close the
 * colored span early on the next load, an unmatched `<span ...>` would keep it
 * from closing. Tags already escaped stay as they are.
 */
export function escapeUnbalancedSpanTags(text: string): string {
  const open: number[] = [];
  const escapeAt: number[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === '\\') {
      i += 2;
      continue;
    }
    if (text[i] === '<') {
      SPAN_TAG_AT.lastIndex = i;
      const tag = SPAN_TAG_AT.exec(text);
      if (tag) {
        if (tag[0][1] !== '/') open.push(i);
        else if (open.length > 0) open.pop();
        else escapeAt.push(i);
        i += tag[0].length;
        continue;
      }
    }
    i += 1;
  }
  return insertEscapes(text, [...escapeAt, ...open].sort((a, b) => a - b));
}

function insertEscapes(text: string, offsets: number[]): string {
  let out = text;
  for (let k = offsets.length - 1; k >= 0; k -= 1) out = `${out.slice(0, offsets[k])}\\${out.slice(offsets[k])}`;
  return out;
}

/** The palette entry a written value belongs to, or null for any other color. */
export function paletteNameForValue(value: string, kind: TextColorKind): TextColorName | null {
  const lower = value.trim().toLowerCase();
  const swatch = TEXT_COLOR_PALETTE.find((entry) => (kind === 'color' ? entry.color : entry.background) === lower);
  return swatch ? swatch.name : null;
}

export function textColorCssVariable(name: TextColorName, kind: TextColorKind): string {
  return kind === 'color' ? `--nim-text-color-${name}` : `--nim-text-bg-${name}`;
}

/** The CSS value to draw: the theme variable for a palette value (falling back to the hex), otherwise the value as written. */
export function textColorCssValue(value: string, kind: TextColorKind): string {
  const name = paletteNameForValue(value, kind);
  return name ? `var(${textColorCssVariable(name, kind)}, ${value.trim()})` : value;
}

/** Inline CSS declarations for drawing a colored span (theme variables for palette values). */
export function textColorRenderStyle(style: TextColorStyle): { color?: string; backgroundColor?: string } {
  return {
    ...(style.color ? { color: textColorCssValue(style.color, 'color') } : {}),
    ...(style.backgroundColor ? { backgroundColor: textColorCssValue(style.backgroundColor, 'background') } : {}),
  };
}
