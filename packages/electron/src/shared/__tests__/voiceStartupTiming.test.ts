// @vitest-environment node
import { expect, it } from 'vitest';
import { VoiceStartupTiming } from '../voiceStartupTiming';

it('correlates stages using durations only and stops recording after completion', () => {
  let now = 10;
  const records: Record<string, string | number>[] = [];
  const timing = new VoiceStartupTiming('main', 'private prompt /Users/private sk-secret', () => now, r => records.push(r));
  now = 35;
  timing.mark('session-context');
  now = 5035;
  timing.mark('extension-context-timeout');
  now = 5135;
  timing.finish('failed');
  timing.mark('live-session-ready');
  timing.finish('ready');
  expect(records).toHaveLength(4);
  expect(records[1]).toMatchObject({ stageMs: 25, elapsedMs: 25 });
  expect(records[2]).toMatchObject({ stageMs: 5000, elapsedMs: 5025 });
  expect(records[3]).toMatchObject({ outcome: 'failed', elapsedMs: 5125 });
  expect(JSON.stringify(records)).not.toMatch(/private|sk-secret/);
  const renderer = new VoiceStartupTiming('renderer', timing.id, () => now, r => records.push(r));
  expect(renderer.id).toBe(timing.id);
});
