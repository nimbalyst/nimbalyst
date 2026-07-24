import { describe, expect, it } from 'vitest';
import { mapAiSessionStatusToTaskStatus } from '../taskStatus';

describe('mapAiSessionStatusToTaskStatus', () => {
  it('marks a running session as running, not waiting', () => {
    const s = mapAiSessionStatusToTaskStatus({ id: 's1', title: 'Design', status: 'running' });
    expect(s).toEqual({
      sessionId: 's1',
      title: 'Design',
      status: 'running',
      running: true,
      waitingForInput: false,
    });
  });

  it('distinguishes waiting_for_input from running', () => {
    const s = mapAiSessionStatusToTaskStatus({ id: 's2', title: null, status: 'waiting_for_input' });
    expect(s.running).toBe(false);
    expect(s.waitingForInput).toBe(true);
    expect(s.status).toBe('waiting_for_input');
  });

  it('treats idle/error/finished as not running', () => {
    expect(mapAiSessionStatusToTaskStatus({ id: 'a', title: null, status: 'idle' }).running).toBe(false);
    expect(mapAiSessionStatusToTaskStatus({ id: 'b', title: null, status: 'error' }).running).toBe(false);
  });

  it('falls back to idle for missing/unknown status', () => {
    expect(mapAiSessionStatusToTaskStatus({ id: 'c', title: null, status: null }).status).toBe('idle');
    expect(mapAiSessionStatusToTaskStatus({ id: 'd', title: null, status: 'bogus' }).status).toBe('idle');
  });
});
