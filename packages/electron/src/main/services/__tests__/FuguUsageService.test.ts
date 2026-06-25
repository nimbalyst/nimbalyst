import { describe, expect, it } from 'vitest';
import { extractUsageWindows } from '../FuguUsageService';

describe('extractUsageWindows', () => {
  it('parses primary and secondary account usage windows', () => {
    const out = extractUsageWindows({
      usage: {
        primary: {
          used_percent: 31.4,
          resets_at: '2026-06-23T18:00:00Z',
        },
        secondary: {
          used_percent: 42.9,
          resets_at: 1782244800,
        },
      },
    });

    expect(out?.fiveHour.utilization).toBe(31.4);
    expect(out?.fiveHour.resetsAt).toBe('2026-06-23T18:00:00.000Z');
    expect(out?.sevenDay.utilization).toBe(42.9);
    expect(out?.sevenDay.resetsAt).toBe('2026-06-23T20:00:00.000Z');
  });

  it('calculates utilization from used and limit fields', () => {
    const out = extractUsageWindows({
      limits: [
        { window_minutes: 300, used: 25, limit: 100 },
        { window_minutes: 10080, usage: 6, maximum: 20 },
      ],
    });

    expect(out?.fiveHour.utilization).toBe(25);
    expect(out?.sevenDay.utilization).toBe(30);
  });

  it('calculates utilization from remaining and limit fields', () => {
    const out = extractUsageWindows({
      quota: [
        { period: '5-hour', remaining: 75, limit: 100 },
        { period: 'weekly', remaining_quota: 30, cap: 100 },
      ],
    });

    expect(out?.fiveHour.utilization).toBe(25);
    expect(out?.sevenDay.utilization).toBe(70);
  });

  it('clamps invalid utilization percentages to the display range', () => {
    const out = extractUsageWindows({
      five_hour: { percent: 144 },
      seven_day: { percent: -12 },
    });

    expect(out?.fiveHour.utilization).toBe(100);
    expect(out?.sevenDay.utilization).toBe(0);
  });
});
