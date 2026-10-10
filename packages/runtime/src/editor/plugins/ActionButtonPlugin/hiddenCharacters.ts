/**
 * Characters a reviewer cannot see but a model reads: format characters
 * (category Cf, which covers zero-width characters, bidi controls and most of
 * the tag block), the whole tag block U+E0000-E007F, and control characters
 * other than newline and tab. Text written into a page by someone else can
 * smuggle instructions in these ("Summarize." followed by tag characters
 * spelling out a second command), so a prompt holding any of them is refused,
 * and shown escaped so the reader sees exactly what was there.
 */

const HIDDEN = /[\p{Cf}\u{E0000}-\u{E007F}\u0000-\u0008\u000B-\u001F\u007F-\u009F\u2028\u2029]/gu;

export function countHiddenCharacters(text: string): number {
  return text.match(HIDDEN)?.length ?? 0;
}

/** The text with every hidden character written as `\u{XXXX}`. */
export function escapeHiddenCharacters(text: string): string {
  return text.replace(HIDDEN, (char) => `\\u{${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}}`);
}
