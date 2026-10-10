// Single build switch shared with main and renderer; scraper documents re-enable prerequisites.
export const OLLAMA_RESET_SCRAPE_ENABLED: boolean = false;
export type OllamaWindowKind = 'session' | 'weekly';
export type OllamaDurationSource = 'provider' | 'nominal';
// Nominal lengths come from the requester's stated plan windows (5h/weekly),
// authorized by the owner follow-up; they are not an Ollama API guarantee.
export const OLLAMA_NOMINAL_WINDOW_MS = { session: 5 * 60 * 60 * 1000, weekly: 7 * 24 * 60 * 60 * 1000 } as const;

/** Provider bounds take precedence over labeled nominal lengths; never first-seen time. */
export interface OllamaResetWindow {
  resetsAt: string;
  windowStart: string | null;
  windowEnd: string;
  durationSource?: OllamaDurationSource;
}
export type OllamaResetTimeStatus = 'not-set' | 'ok' | 'cookie-expired' | 'error';

export function resetTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const [year, month, day, hour, minute, second] = value.slice(0, 19).split(/[-T:]/).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1] || hour > 23 || minute > 59 || second > 59) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

export function resetWindow(value: unknown, kind?: OllamaWindowKind): OllamaResetWindow | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<OllamaResetWindow>;
  const end = resetTimestamp(raw.resetsAt);
  if (!end || resetTimestamp(raw.windowEnd) !== end) return null;
  let start = resetTimestamp(raw.windowStart);
  let durationSource: OllamaDurationSource = raw.durationSource === 'nominal' ? 'nominal' : 'provider';
  if (kind && raw.windowStart == null && raw.durationSource == null) {
    start = new Date(Date.parse(end) - OLLAMA_NOMINAL_WINDOW_MS[kind]).toISOString();
    durationSource = 'nominal';
  }
  const validStart = start && Date.parse(start) < Date.parse(end) ? start : null;
  return { resetsAt: end, windowEnd: end, windowStart: validStart,
    ...(validStart || raw.durationSource === 'provider' ? { durationSource } : {}) };
}
