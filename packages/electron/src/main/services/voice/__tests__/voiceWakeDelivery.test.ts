// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { deliverInteractivePrompt, deliverVoiceAnnouncement } from '../voiceWakeDelivery';

const QUESTION = {
  promptId: 'prompt-1',
  promptType: 'ask_user_question_request',
  description: 'Text or integer for the status column?',
};

/** A voice engine whose transport comes back a few polls after the wake. */
function sleepingEngine(options: { connectAfterPolls: number }) {
  const delivered: string[] = [];
  let connected = false;
  let restoring = false;
  let polls = 0;
  return {
    delivered,
    engine: {
      isConnected: () => connected,
      sendHostAnnouncement: (text: string) => {
        if (!connected) return false;
        delivered.push(text);
        return true;
      },
      setListeningPaused: (paused: boolean) => {
        if (!paused) restoring = true;
      },
    },
    /** Injected sleep: the restore completes while the delivery waits. */
    sleep: async () => {
      polls += 1;
      if (restoring && polls >= options.connectAfterPolls) connected = true;
    },
  };
}

describe('deliverInteractivePrompt', () => {
  it('delivers a late coding answer exactly once after reconnecting', async () => {
    const { engine, delivered, sleep } = sleepingEngine({ connectAfterPolls: 3 });
    expect(await deliverVoiceAnnouncement(engine, 'The coding turn finished.', {
      timeoutMs: 1000, pollMs: 10, sleep,
    })).toBe(true);
    expect(delivered).toEqual(['The coding turn finished.']);
  });

  it('delivers the question that caused the wake once the session is back', async () => {
    const { engine, delivered, sleep } = sleepingEngine({ connectAfterPolls: 3 });

    // The queue woke a sleeping session and sent the question straight after.
    // The engine is not connected yet -- on Live the paid transport is still
    // reopening -- and dropping the message here discards the whole point of
    // having woken up.
    const ok = await deliverInteractivePrompt(engine, QUESTION, { timeoutMs: 1000, pollMs: 10, sleep });

    expect(ok).toBe(true);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain('prompt-1');
    expect(delivered[0]).toContain('status column');
  });

  it('reports failure rather than pretending a question was asked', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const engine = {
      isConnected: () => false,
      sendHostAnnouncement: () => false,
      setListeningPaused: () => {},
    };

    const ok = await deliverInteractivePrompt(engine, QUESTION, {
      timeoutMs: 50,
      pollMs: 10,
      sleep: async () => {},
    });

    expect(ok).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it('gives up when the voice session was replaced while it waited', async () => {
    const { engine, delivered, sleep } = sleepingEngine({ connectAfterPolls: 2 });

    const ok = await deliverInteractivePrompt(engine, QUESTION, {
      timeoutMs: 1000,
      pollMs: 10,
      sleep,
      isCurrent: () => false,
    });

    // Delivering into a session the user has since ended or replaced would put
    // the question in a conversation that is not the one it was queued for.
    expect(ok).toBe(false);
    expect(delivered).toEqual([]);
  });
});
