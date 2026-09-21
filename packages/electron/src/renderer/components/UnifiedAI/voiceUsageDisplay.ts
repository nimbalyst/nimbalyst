/**
 * Turning a voice usage report into something displayable, per engine.
 *
 * The two engines measure different things. Realtime counts tokens; Live bills
 * per second and reports context occupancy directly. A field this engine does
 * not report is `undefined`, and `undefined` is not zero -- every rule below
 * exists so an unmeasured quantity renders as nothing at all rather than as a
 * confident `0` or an empty ring that reads as "plenty of room left".
 *
 * Pure on purpose: the interesting bugs here are arithmetic and absence
 * handling, and neither needs a rendered tree to catch.
 */

import type { VoiceEngineId, VoiceTokenUsage } from '../../store/atoms/voiceModeState';

/** Live list price as of 2026-09-11: $0.05 per minute, billed per second. */
export const LIVE_COST_PER_MINUTE_USD = 0.05;

export type VoiceUsageTone = 'ok' | 'warn' | 'critical';

export interface VoiceUsageLine {
  id: 'context' | 'tokens' | 'duration' | 'cost' | 'backend';
  label: string;
  value: string;
}

export interface VoiceUsageDisplay {
  engine: VoiceEngineId;
  /**
   * Ring occupancy, 0..1. `null` means nothing measured occupancy -- draw no
   * ring rather than an empty one.
   */
  occupancy: number | null;
  occupancyTone: VoiceUsageTone | null;
  /** Voice-session lines. Controller cost is never mixed in here. */
  lines: VoiceUsageLine[];
  /** True when the transport died before final usage arrived: the figures are a floor. */
  isFloor: boolean;
}

/** mm:ss, or h:mm:ss past an hour. Negative and non-finite input reads as 0:00. */
export function formatVoiceDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const whole = Math.floor(seconds);
  const s = whole % 60;
  const m = Math.floor(whole / 60) % 60;
  const h = Math.floor(whole / 3600);
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

/**
 * Live duration cost. Sub-cent amounts read as `<$0.01` rather than `$0.00`,
 * which would claim the session was free.
 */
export function formatLiveCost(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '$0.00';
  const usd = (seconds / 60) * LIVE_COST_PER_MINUTE_USD;
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

function toneFor(occupancy: number): VoiceUsageTone {
  if (occupancy > 0.8) return 'critical';
  if (occupancy > 0.6) return 'warn';
  return 'ok';
}

/** CSS variable for a tone. Never a hardcoded color. */
export function voiceUsageToneVar(tone: VoiceUsageTone): string {
  return tone === 'critical'
    ? 'var(--nim-error)'
    : tone === 'warn'
      ? 'var(--nim-warning)'
      : 'var(--nim-success)';
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Which engine a report came from. C1 stamps `engine`; older reports and any
 * engine that forgets to are classified by what they actually measured, so a
 * duration report never gets displayed as tokens.
 */
export function resolveUsageEngine(usage: VoiceTokenUsage): VoiceEngineId {
  if (usage.engine) return usage.engine;
  if (isNumber(usage.durationSeconds) || isNumber(usage.contextUsageRatio)) return 'live';
  return 'realtime';
}

export function buildVoiceUsageDisplay(usage: VoiceTokenUsage | null | undefined): VoiceUsageDisplay | null {
  if (!usage) return null;

  const engine = resolveUsageEngine(usage);
  const lines: VoiceUsageLine[] = [];
  let occupancy: number | null = null;

  if (engine === 'live') {
    // Occupancy comes from the engine's own ratio. We never derive one from a
    // divisor of ours -- that derived number is exactly what this replaces.
    if (isNumber(usage.contextUsageRatio)) {
      occupancy = Math.min(1, Math.max(0, usage.contextUsageRatio));
      lines.push({ id: 'context', label: 'Context', value: `${Math.round(occupancy * 100)}%` });
    }
    if (isNumber(usage.durationSeconds)) {
      lines.push({ id: 'duration', label: 'Voice time', value: formatVoiceDuration(usage.durationSeconds) });
      lines.push({ id: 'cost', label: 'Voice cost', value: formatLiveCost(usage.durationSeconds) });
    }
  } else if (isNumber(usage.total)) {
    // Cumulative token usage does not measure remaining context capacity.
    lines.push({
      id: 'tokens',
      label: 'Tokens used',
      value: usage.total.toLocaleString(),
    });
  }

  // Controller usage stays its own line. Its billing shape is the backend
  // model's, so we report how many responses it covered and nothing more --
  // inventing a dollar figure from an opaque usage block would be a guess.
  if (usage.backend && usage.backend.length > 0) {
    const n = usage.backend.length;
    lines.push({ id: 'backend', label: 'Controller', value: `${n} ${n === 1 ? 'response' : 'responses'}` });
  }

  if (lines.length === 0) return null;

  return {
    engine,
    occupancy,
    occupancyTone: occupancy === null ? null : toneFor(occupancy),
    lines,
    isFloor: usage.finalizationMissing === true,
  };
}
