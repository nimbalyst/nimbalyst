/**
 * The excerpt fence's language and header separator, and a check for a saved
 * size, without the YAML parser: the node, transformer and block menu load
 * eagerly in the web console, where the parser would cost every page.
 */

export const CODE_EXCERPT_FENCE_LANGUAGE = 'excerpt';
export const EXCERPT_SEPARATOR = '---';

/** Whether the header (above `---`) has a `width:` or `height:` line. */
export function excerptHasSize(source: string): boolean {
  for (const line of source.split('\n')) {
    if (line.trimEnd() === EXCERPT_SEPARATOR) return false;
    if (/^(width|height)\s*:/.test(line)) return true;
  }
  return false;
}
