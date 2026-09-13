/**
 * Tests for per-model weekly limits in the Claude usage payload.
 *
 * The usage API used to expose a dedicated `seven_day_opus` object, and the
 * panel read only that field. The API now reports `seven_day_opus: null` and
 * publishes per-model limits in the generic `limits[]` array as
 * `kind: "weekly_scoped"` entries carrying `scope.model.display_name`. With
 * only the old field wired up, a user sitting at 100% on a model-scoped weekly
 * limit saw no bar at all - the panel showed session and weekly and nothing
 * else, which is exactly the number they needed.
 *
 * These tests pin the `limits[]` reader, the legacy fallback, and the fact
 * that we trust the API's own severity grading instead of re-deriving one.
 */
import { describe, it, expect } from 'vitest';
import { extractScopedLimits } from '../claudeUsageLimits';

/** Trimmed copy of a real response: legacy field null, scoped limit in limits[]. */
const CURRENT_PAYLOAD = {
  five_hour: { utilization: 86.0, resets_at: '2026-09-13T07:29:59.864341+00:00' },
  seven_day: { utilization: 57.0, resets_at: '2026-09-13T14:59:59.864361+00:00' },
  seven_day_opus: null,
  seven_day_sonnet: null,
  limits: [
    {
      kind: 'session',
      group: 'session',
      percent: 86,
      severity: 'warning',
      resets_at: '2026-09-13T07:29:59.864341+00:00',
      scope: null,
      is_active: false,
    },
    {
      kind: 'weekly_all',
      group: 'weekly',
      percent: 57,
      severity: 'normal',
      resets_at: '2026-09-13T14:59:59.864361+00:00',
      scope: null,
      is_active: false,
    },
    {
      kind: 'weekly_scoped',
      group: 'weekly',
      percent: 100,
      severity: 'critical',
      resets_at: '2026-09-13T14:59:59.864559+00:00',
      scope: { model: { id: null, display_name: 'Fable' }, surface: null },
      is_active: true,
    },
  ],
};

describe('extractScopedLimits', () => {
  it('surfaces a model-scoped weekly limit that the legacy field no longer reports', () => {
    const limits = extractScopedLimits(CURRENT_PAYLOAD);

    expect(limits).toHaveLength(1);
    expect(limits[0]).toMatchObject({
      label: 'Fable',
      utilization: 100,
      resetsAt: '2026-09-13T14:59:59.864559+00:00',
      severity: 'critical',
    });
  });

  it('ignores account-wide session and weekly entries', () => {
    const labels = extractScopedLimits(CURRENT_PAYLOAD).map((limit) => limit.label);
    expect(labels).toEqual(['Fable']);
  });

  it('returns every scoped limit, with stable distinct ids', () => {
    const limits = extractScopedLimits({
      limits: [
        {
          kind: 'weekly_scoped',
          percent: 100,
          severity: 'critical',
          resets_at: null,
          scope: { model: { id: null, display_name: 'Fable' } },
        },
        {
          kind: 'weekly_scoped',
          percent: 12,
          severity: 'normal',
          resets_at: null,
          scope: { model: { id: 'claude-opus-5', display_name: 'Opus' } },
        },
      ],
    });

    expect(limits.map((limit) => limit.label)).toEqual(['Fable', 'Opus']);
    expect(new Set(limits.map((limit) => limit.id)).size).toBe(2);
  });

  it('falls back to the legacy seven_day_opus field when limits[] carries no scoped entry', () => {
    const limits = extractScopedLimits({
      seven_day_opus: { utilization: 42, resets_at: '2026-09-13T14:59:59Z' },
      limits: [{ kind: 'session', percent: 10, severity: 'normal', scope: null }],
    });

    expect(limits).toEqual([
      {
        id: 'weekly_scoped:opus:legacy',
        label: 'Opus',
        utilization: 42,
        resetsAt: '2026-09-13T14:59:59Z',
        severity: 'normal',
      },
    ]);
  });

  it('derives a severity when the API omits one', () => {
    const [limit] = extractScopedLimits({
      limits: [
        {
          kind: 'weekly_scoped',
          percent: 91,
          resets_at: null,
          scope: { model: { display_name: 'Fable' } },
        },
      ],
    });

    expect(limit.severity).toBe('critical');
  });

  it('skips scoped entries with no model name, and tolerates a missing limits array', () => {
    expect(
      extractScopedLimits({ limits: [{ kind: 'weekly_scoped', percent: 50, scope: { surface: {} } }] })
    ).toEqual([]);
    expect(extractScopedLimits({})).toEqual([]);
    expect(extractScopedLimits(null)).toEqual([]);
  });
});
