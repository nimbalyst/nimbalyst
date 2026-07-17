import { describe, expect, it } from 'vitest';
import {
  formatCodexWindowLabel,
  formatCodexWindowSubtitle,
  getCodexUsageWindows,
  getMostConstrainedCodexWindow,
  type CodexUsageData,
  type CodexUsageWindow,
} from '../codexUsageAtoms';

function window(
  slot: CodexUsageWindow['slot'],
  usedPercent: number,
  windowDurationMins: number | null
): CodexUsageWindow {
  return { slot, usedPercent, windowDurationMins, resetsAt: null };
}

describe('Codex usage window display', () => {
  it('labels a weekly primary window from its duration', () => {
    const weekly = window('primary', 36, 10_080);
    expect(formatCodexWindowLabel(weekly)).toBe('Weekly');
    expect(formatCodexWindowSubtitle(weekly)).toBe('7-day window');
  });

  it('selects the most constrained window for the compact indicator', () => {
    const usage: CodexUsageData = {
      limits: [
        {
          id: 'codex',
          name: null,
          planType: 'pro',
          windows: [window('primary', 18, 300), window('secondary', 62, 10_080)],
          credits: null,
          individualLimit: null,
          rateLimitReachedType: null,
        },
        {
          id: 'codex_bengalfox',
          name: 'GPT-5.3-Codex-Spark',
          planType: 'pro',
          windows: [window('primary', 4, 10_080)],
          credits: null,
          individualLimit: null,
          rateLimitReachedType: null,
        },
      ],
      lastUpdated: 0,
    };

    const selected = getMostConstrainedCodexWindow(usage);
    expect(selected?.limit.id).toBe('codex');
    expect(selected?.window.usedPercent).toBe(62);
    expect(formatCodexWindowLabel(selected!.window)).toBe('Weekly');
  });

  it('tolerates payloads without limits (older main process or cached pre-limits snapshot)', () => {
    const legacy = { lastUpdated: 1 } as CodexUsageData;
    expect(getCodexUsageWindows(legacy)).toEqual([]);
    expect(getMostConstrainedCodexWindow(legacy)).toBeNull();
  });

  it('tolerates limits without windows', () => {
    const partial = {
      lastUpdated: 1,
      limits: [{ id: 'a' }],
    } as unknown as CodexUsageData;
    expect(getCodexUsageWindows(partial)).toEqual([]);
  });
});
