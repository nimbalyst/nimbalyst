import { describe, expect, it, vi } from 'vitest';
import { createQueuedStreamTruthBinder } from '../queuedPromptTruth';

describe('MessageStreamingHandler queued truth spine', () => {
  it('binds user, text, tool, edit, tool-error, and assistant variants to one monotonic turn', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-03T00:00:00.000Z'));
    const nextTruth = createQueuedStreamTruthBinder({
      clientSubmissionId: 'client-1',
      queueRowId: 'row-1',
      sourceSessionId: 'session-1',
      sourceRoomId: 'room-1',
      turnId: 'turn-1',
      providerInputMessageId: 'input-1',
      providerOutputMessageId: 'output-1',
    });

    const user = nextTruth('streaming')!;
    const text = nextTruth('streaming')!;
    const tool = nextTruth('streaming')!;
    const edit = nextTruth('streaming')!;
    const toolError = nextTruth('streaming')!;
    const assistantText = nextTruth('completed')!;
    vi.advanceTimersByTime(1_000);
    const terminal = nextTruth('completed')!;

    for (const truth of [user, text, tool, edit, toolError, assistantText, terminal]) {
      expect(truth).toMatchObject({
        clientSubmissionId: 'client-1', queueRowId: 'row-1', sourceSessionId: 'session-1',
        sourceRoomId: 'room-1', turnId: 'turn-1', providerInputMessageId: 'input-1',
        providerOutputMessageId: 'output-1',
      });
    }
    expect([user, text, tool, edit, toolError, assistantText, terminal].map((truth) => truth.eventSequence))
      .toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(assistantText).toMatchObject({ lifecycle: 'completed', terminalAt: Date.parse('2026-08-03T00:00:00.000Z') });
    expect(terminal).toMatchObject({ lifecycle: 'completed', terminalAt: Date.parse('2026-08-03T00:00:00.000Z') });
    vi.useRealTimers();
  });

  it('gives a thrown-exception terminal one failed identity and time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-03T00:01:00.000Z'));
    const nextTruth = createQueuedStreamTruthBinder({ queueRowId: 'row-2', turnId: 'turn-2' });
    const partial = nextTruth('streaming')!;
    const persistedError = nextTruth('failed')!;
    const rendererTerminal = nextTruth('failed')!;

    expect(partial).toMatchObject({ lifecycle: 'streaming', eventSequence: 1 });
    expect(persistedError).toMatchObject({ lifecycle: 'failed', eventSequence: 2 });
    expect(rendererTerminal).toMatchObject({ lifecycle: 'failed', eventSequence: 3 });
    expect(persistedError.terminalAt).toBe(rendererTerminal.terminalAt);
    vi.useRealTimers();
  });
});
