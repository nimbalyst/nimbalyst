/**
 * Regression tests for the Codex usage rate-limit expiry filter (#120).
 *
 * Before the fix, `extractRateLimitsFromEvent` returned any token_count event
 * whose `primary` block was non-null, regardless of whether its `resets_at`
 * timestamp had already passed. After a user's 5-hour window reset, the
 * scan-backward loop in `extractUsageSnapshotFromFile` kept matching the same
 * stale JSONL line and the bottom-left indicator sat on the historical
 * percentage (91% in the reporter's case) forever - across panel refreshes,
 * app relaunches, and machine restarts.
 *
 * These tests pin the per-bucket expiry filter that drops resolution after
 * each window's `resets_at` moment passes, while still surfacing a
 * still-active sibling window.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyRateLimitWindows,
  filterRateLimitsByExpiry,
} from '../CodexUsageService';

// 2026-05-14T12:00:00Z, in Unix seconds. Each test pins a specific "now"
// relative to this anchor so resets_at math is human-readable.
const NOW_SECONDS = 1778832000;
const FIVE_HOURS = 5 * 60 * 60;
const SEVEN_DAYS = 7 * 24 * 60 * 60;

function primary(used_percent: number, resets_at: number) {
  return { used_percent, window_minutes: 300, resets_at };
}

function secondary(used_percent: number, resets_at: number) {
  return { used_percent, window_minutes: 7 * 24 * 60, resets_at };
}

describe('filterRateLimitsByExpiry', () => {
  it('returns the block unchanged when both windows are still active', () => {
    const input = {
      primary: primary(42, NOW_SECONDS + FIVE_HOURS),
      secondary: secondary(18, NOW_SECONDS + SEVEN_DAYS),
    };
    const out = filterRateLimitsByExpiry(input, NOW_SECONDS);
    expect(out).not.toBeNull();
    expect(out!.primary?.used_percent).toBe(42);
    expect(out!.secondary?.used_percent).toBe(18);
  });

  it('drops only the primary when its resets_at has passed', () => {
    const input = {
      primary: primary(91, NOW_SECONDS - 60),
      secondary: secondary(18, NOW_SECONDS + SEVEN_DAYS),
    };
    const out = filterRateLimitsByExpiry(input, NOW_SECONDS);
    expect(out).not.toBeNull();
    expect(out!.primary).toBeNull();
    expect(out!.secondary?.used_percent).toBe(18);
  });

  it('drops only the secondary when its resets_at has passed', () => {
    const input = {
      primary: primary(42, NOW_SECONDS + FIVE_HOURS),
      secondary: secondary(99, NOW_SECONDS - 60),
    };
    const out = filterRateLimitsByExpiry(input, NOW_SECONDS);
    expect(out).not.toBeNull();
    expect(out!.primary?.used_percent).toBe(42);
    expect(out!.secondary).toBeNull();
  });

  it('AnisminC #120 scenario: returns null when primary is stale and there is no secondary', () => {
    // Reporter's stuck-91% case. Recent JSONL line had primary used_percent=91
    // with a resets_at that has since passed; no secondary block at all.
    const input = {
      primary: primary(91, NOW_SECONDS - 3 * 60 * 60),
    };
    const out = filterRateLimitsByExpiry(input, NOW_SECONDS);
    // Returning null lets the caller keep scanning older lines / files for a
    // still-active block. If nothing is active anywhere, the higher-level
    // snapshot falls through to limitsAvailable: false and the renderer
    // shows `--` instead of the stale 91%.
    expect(out).toBeNull();
  });

  it('returns null when both windows are expired', () => {
    const input = {
      primary: primary(91, NOW_SECONDS - 60),
      secondary: secondary(50, NOW_SECONDS - 60),
    };
    const out = filterRateLimitsByExpiry(input, NOW_SECONDS);
    expect(out).toBeNull();
  });

  it('treats resets_at exactly equal to now as expired (boundary)', () => {
    const input = {
      primary: primary(80, NOW_SECONDS),
    };
    const out = filterRateLimitsByExpiry(input, NOW_SECONDS);
    expect(out).toBeNull();
  });

  it('treats missing resets_at (undefined) as active so an upstream schema gap does not silently drop the signal', () => {
    // A token_count event with rate_limits.primary present but resets_at absent
    // (older Codex SDK builds, missing field on a partial write, etc.) should
    // be surfaced rather than dropped. NaN, by contrast, is treated as expired
    // (NaN > x is false) - we fail-closed on genuinely garbage data.
    const input = {
      primary: { used_percent: 30, window_minutes: 300 } as unknown as {
        used_percent: number;
        window_minutes: number;
        resets_at: number;
      },
    };
    const out = filterRateLimitsByExpiry(input, NOW_SECONDS);
    expect(out).not.toBeNull();
    expect(out!.primary?.used_percent).toBe(30);
  });

  it('preserves the credits block on the active side', () => {
    const input = {
      primary: primary(42, NOW_SECONDS + FIVE_HOURS),
      credits: { has_credits: true, unlimited: false, balance: 12.5 },
    };
    const out = filterRateLimitsByExpiry(input, NOW_SECONDS);
    expect(out).not.toBeNull();
    expect(out!.credits?.balance).toBe(12.5);
  });

  it('preserves the limit_id field on the active side', () => {
    const input = {
      limit_id: 'usage-bucket-7',
      primary: primary(42, NOW_SECONDS + FIVE_HOURS),
    };
    const out = filterRateLimitsByExpiry(input, NOW_SECONDS);
    expect(out).not.toBeNull();
    expect(out!.limit_id).toBe('usage-bucket-7');
  });
});

describe('classifyRateLimitWindows', () => {
  it('classifies the legacy primary/secondary shape by duration', () => {
    const windows = classifyRateLimitWindows({
      primary: primary(42, NOW_SECONDS + FIVE_HOURS),
      secondary: secondary(18, NOW_SECONDS + SEVEN_DAYS),
    });

    expect(windows.fiveHour?.used_percent).toBe(42);
    expect(windows.sevenDay?.used_percent).toBe(18);
  });

  it('classifies a weekly-only primary bucket as weekly', () => {
    const windows = classifyRateLimitWindows({
      primary: secondary(11, NOW_SECONDS + SEVEN_DAYS),
      secondary: null,
    });

    expect(windows.fiveHour).toBeNull();
    expect(windows.sevenDay?.used_percent).toBe(11);
  });

  it('classifies reordered buckets by duration instead of slot', () => {
    const windows = classifyRateLimitWindows({
      primary: secondary(18, NOW_SECONDS + SEVEN_DAYS),
      secondary: primary(42, NOW_SECONDS + FIVE_HOURS),
    });

    expect(windows.fiveHour?.used_percent).toBe(42);
    expect(windows.sevenDay?.used_percent).toBe(18);
  });
});
