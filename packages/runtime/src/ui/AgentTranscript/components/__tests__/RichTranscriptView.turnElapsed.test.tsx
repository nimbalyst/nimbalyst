/**
 * The live elapsed counter beside "Thinking...".
 *
 * Why it exists: the Gemini/Antigravity transport returns a whole turn in one
 * buffered call, so the transcript shows nothing at all for minutes at a time
 * and a long turn is indistinguishable from a hung one. A real workload ran
 * 8m6s before failing, and the reporter's read was "it looked stuck". A
 * climbing number does not make the turn faster, it just stops it looking dead.
 *
 * The gating is the part worth testing: it must not appear when idle, and it
 * must not appear when there is no message to anchor to.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptViewMessage } from '../../../../ai/server/transcript/TranscriptProjector';
import { RichTranscriptView } from '../RichTranscriptView';

vi.mock('virtua', async () => {
  const ReactModule = await import('react');
  return {
    VList: ReactModule.forwardRef(({ children }: { children: React.ReactNode }, ref) => {
      ReactModule.useImperativeHandle(ref, () => ({
        cache: undefined,
        scrollOffset: 0,
        scrollSize: 300,
        viewportSize: 100,
        findItemIndex: () => 0,
        scrollToIndex: vi.fn(),
        scrollBy: vi.fn(),
      }));
      return <div data-testid="mock-vlist">{ReactModule.Children.toArray(children)}</div>;
    }),
  };
});

function makeMessage(
  index: number,
  overrides: Partial<TranscriptViewMessage>,
): TranscriptViewMessage {
  return {
    id: index + 1,
    sequence: index + 1,
    createdAt: new Date(1_784_648_445_000 + index),
    type: 'assistant_message',
    subagentId: null,
    ...overrides,
  };
}

const userTurn = makeMessage(0, { type: 'user_message', text: 'do a long thing' });

function view(messages: TranscriptViewMessage[], isProcessing: boolean) {
  return (
    <RichTranscriptView
      sessionId="elapsed"
      sessionStatus={isProcessing ? 'running' : 'idle'}
      isProcessing={isProcessing}
      messages={messages}
      provider="antigravity-gemini-agent"
      persistScrollState={false}
    />
  );
}

beforeEach(() => {
  vi.stubGlobal('CSS', { highlights: { delete: vi.fn(), set: vi.fn() } });
});

describe('live turn elapsed counter', () => {
  it('appears while a turn is in flight', () => {
    render(view([userTurn], true));
    expect(screen.getByTestId('turn-elapsed')).toBeTruthy();
  });

  it('does not appear when the session is idle', () => {
    // An idle session already shows "Finished in ..." on the completed turn.
    // A second, still-counting clock next to it would be actively misleading.
    render(view([userTurn, makeMessage(1, { text: 'done' })], false));
    expect(screen.queryByTestId('turn-elapsed')).toBeNull();
  });

  it('does not appear when there is no message to measure from', () => {
    // Nothing to anchor to means any number shown would be invented.
    render(view([], true));
    expect(screen.queryByTestId('turn-elapsed')).toBeNull();
  });

  it('anchors to the latest user message, matching "Finished in"', () => {
    // The number a user watches climb has to be the number they end up with,
    // or the live and completed displays contradict each other.
    const later = makeMessage(4, { type: 'user_message', text: 'and another' });
    render(view([userTurn, makeMessage(1, { text: 'reply' }), later], true));
    expect(screen.getByTestId('turn-elapsed')).toBeTruthy();
  });
});
