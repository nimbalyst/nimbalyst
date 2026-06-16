/**
 * Relative / absolute time parsing for --since / --until.
 *
 * Accepts: `1d`, `2w`, `3h`, `30m`, `45s` (relative to now) or an absolute date
 * like `2026-06-01` / a full ISO timestamp. Returns an ISO string suitable for
 * lexicographic comparison against the ISO `updated` / `created` columns.
 */
import { usageError } from './exitCodes.js';

const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
};

export function parseTimeBound(value: string): string {
  const rel = value.match(/^(\d+)\s*([smhdw])$/i);
  if (rel) {
    const amount = Number.parseInt(rel[1], 10);
    const unit = rel[2].toLowerCase();
    const ms = amount * UNIT_MS[unit];
    return new Date(Date.now() - ms).toISOString();
  }

  // Absolute date or ISO timestamp.
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) {
    throw usageError(
      `Could not parse time "${value}". Use a relative value (1d, 2w, 3h) or an absolute date (2026-06-01).`,
    );
  }
  return new Date(ts).toISOString();
}

/** Human-friendly "2h ago" rendering for table output. */
export function relativeFromNow(iso: string | undefined): string {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const diff = Date.now() - then;
  const abs = Math.abs(diff);
  const pick = (n: number, u: string) => `${n}${u}${diff >= 0 ? '' : ' (future)'}`;
  if (abs < UNIT_MS.m) return 'just now';
  if (abs < UNIT_MS.h) return pick(Math.round(abs / UNIT_MS.m), 'm');
  if (abs < UNIT_MS.d) return pick(Math.round(abs / UNIT_MS.h), 'h');
  if (abs < UNIT_MS.w) return pick(Math.round(abs / UNIT_MS.d), 'd');
  return pick(Math.round(abs / UNIT_MS.w), 'w');
}
