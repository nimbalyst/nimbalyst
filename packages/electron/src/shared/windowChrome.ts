export const MAIN_WINDOW_TITLE_BAR_HEIGHT = 38;

export interface TitleBarOverlayColors {
  color: string;
  symbolColor: string;
}

const MAX_CSS_COLOR_LENGTH = 64;
const HEX_COLOR_PATTERN = /^#[0-9a-f]{3,8}$/i;
const NAMED_COLOR_PATTERN = /^[a-z]{1,24}$/i;
const FUNCTION_COLOR_PATTERN = /^(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\([0-9a-z.,%+\-/\s]+\)$/i;

function isShortCssColor(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_CSS_COLOR_LENGTH) return false;
  return HEX_COLOR_PATTERN.test(trimmed)
    || NAMED_COLOR_PATTERN.test(trimmed)
    || FUNCTION_COLOR_PATTERN.test(trimmed);
}

export function isTitleBarOverlayColors(value: unknown): value is TitleBarOverlayColors {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return isShortCssColor(candidate.color) && isShortCssColor(candidate.symbolColor);
}
