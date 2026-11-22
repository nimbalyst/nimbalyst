const WORD_START = /^[\p{L}\p{N}]/u;

/** Prefix a space when dictated text would otherwise glue onto the previous word. */
export function spaceBefore(prevChar: string, text: string): string {
  return prevChar && !/\s/.test(prevChar) && WORD_START.test(text) ? ' ' + text : text;
}
