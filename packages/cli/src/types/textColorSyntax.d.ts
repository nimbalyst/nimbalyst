/**
 * Types for `@nimbalyst/runtime/core/textColorSyntax`, the app's colored-text
 * parser (packages/runtime/src/core/textColorSyntax.ts), used by the static
 * export to draw colored text without JavaScript.
 *
 * Wired like pageMarkSyntax.d.ts: tsconfig.json `paths` points tsc here while
 * scripts/build.mjs and vitest.config.ts alias the specifier to the source.
 * Keep these a subset of that file's exports.
 */
export interface TextColorStyle {
  color?: string;
  backgroundColor?: string;
}

/** The colors of a whole `<span style="...">` opening tag, or null when it is not a colored-text tag. */
export function parseTextColorOpenTag(tag: string): TextColorStyle | null;

export function formatTextColorStyle(style: TextColorStyle): string;
