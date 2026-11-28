export const DEFAULT_UI_FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif";
export const DEFAULT_CODE_FONT_STACK = "'SF Mono', 'Monaco', 'Menlo', 'Consolas', monospace";
export const DEFAULT_TERMINAL_FONT_STACK = '"SF Mono", Monaco, "Courier New", monospace';

/**
 * Turns the family a user typed into a CSS font-family value that falls back to `fallback`.
 * A single name ("JetBrains Mono") is quoted. A list or quoted name ("Fira Code", monospace)
 * is used as typed. Input that could end the declaration is ignored.
 */
export function toFontFamilyCss(input: string, fallback: string): string {
  const family = input.trim();
  if (family === '' || /[;{}<>\\\n]/.test(family)) return fallback;
  const isList = /[,"']/.test(family);
  return `${isList ? family : `"${family}"`}, ${fallback}`;
}

/** One entry per family, sorted, from the faces `queryLocalFonts()` returns (one per weight and style). */
export function uniqueFontFamilies(faces: ReadonlyArray<{ family: string }>): string[] {
  return [...new Set(faces.map((face) => face.family))].sort((a, b) => a.localeCompare(b));
}
