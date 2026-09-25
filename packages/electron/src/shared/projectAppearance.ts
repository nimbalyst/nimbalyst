/// <reference lib="es2022.intl" />
/** Personal, machine-local overrides. Unset values retain the automatic appearance. */
export interface ProjectAppearance {
  initials?: string;
  color?: string;
  imageUrl?: string;
}
export interface StoredProjectAppearance {
  initials?: string;
  color?: string;
  imageId?: string;
}
export interface ProjectAppearanceUpdate {
  initials?: string | null;
  color?: string | null;
  /** A normalized PNG thumbnail; null removes it, undefined leaves it alone. */
  image?: string | null;
}
export interface ProjectAppearanceSnapshot {
  appearance: ProjectAppearance;
  /** Monotonic within the main-process lifetime, including reset operations. */
  revision: number;
}
export function projectInitials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '??';
  const words = trimmed.split(/[-_\s]+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return trimmed.slice(0, 2).toUpperCase();
}
export function generateWorkspaceAccentColor(path: string, format: 'hsl' | 'hex' = 'hsl'): string {
  let hash = 0;
  for (let i = 0; i < path.length; i++) {
    hash = ((hash << 5) - hash) + path.charCodeAt(i);
    hash &= hash;
  }
  const hue = Math.abs(hash) % 360;
  if (format === 'hsl') return `hsl(${hue}, 65%, 55%)`;
  // Color inputs require hex. Convert the same 65% saturation, 55% lightness.
  const amplitude = 0.65 * Math.min(0.55, 1 - 0.55);
  const channels = [0, 8, 4].map(offset => {
    const k = (offset + hue / 30) % 12;
    const channel = 0.55 - amplitude * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * channel).toString(16).padStart(2, '0');
  });
  return `#${channels.join('')}`;
}
export function initialsLength(text: string): number {
  return Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)).length;
}
/** Choose the higher-contrast foreground for a user-supplied solid color. */
export function projectIconForeground(color?: string): string {
  if (!color) return '#ffffff';
  const channels = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16) / 255)
    .map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const luminance = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  return luminance > 0.179 ? '#000000' : '#ffffff';
}
