// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTranscriptSelectionContext } from '../useTranscriptSelectionContext';
import {
  clearTextSelection,
  getTextSelection,
  setTextSelection,
  transcriptSelectionKey,
} from '../../components/UnifiedAI/TextSelectionIndicator';

function mountTranscript(): { container: HTMLDivElement; reply: Text; question: Text; outside: HTMLTextAreaElement } {
  const container = document.createElement('div');
  container.innerHTML =
    '<div data-message-role="user">Can you check the plan?</div>' +
    '<div data-message-role="assistant">Should we dedupe in investigate mode?</div>';
  const outside = document.createElement('textarea');
  document.body.append(container, outside);
  return {
    container,
    question: container.children[0].firstChild as Text,
    reply: container.children[1].firstChild as Text,
    outside,
  };
}

function select(node: Node, start: number, end: number): void {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  const selection = document.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  act(() => {
    document.dispatchEvent(new Event('selectionchange'));
    vi.advanceTimersByTime(200);
  });
}

describe('useTranscriptSelectionContext', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearTextSelection();
  });

  afterEach(() => {
    vi.useRealTimers();
    clearTextSelection();
    document.body.innerHTML = '';
  });

  it('publishes a selection in an assistant reply, keyed to the session', () => {
    const { container, reply } = mountTranscript();
    renderHook(() => useTranscriptSelectionContext({ current: container }, 's1'));

    select(reply, 0, 15);

    expect(getTextSelection()).toMatchObject({
      text: 'Should we dedup',
      filePath: transcriptSelectionKey('s1'),
      author: 'assistant',
    });
  });

  it("records the user's own message as the source", () => {
    const { container, question } = mountTranscript();
    renderHook(() => useTranscriptSelectionContext({ current: container }, 's1'));

    select(question, 0, 7);

    expect(getTextSelection()?.author).toBe('user');
  });

  it('keeps the selection when focus moves outside the transcript, and clears on a click inside it', () => {
    const { container, reply, outside } = mountTranscript();
    renderHook(() => useTranscriptSelectionContext({ current: container }, 's1'));
    select(reply, 0, 15);

    select(outside, 0, 0);
    expect(getTextSelection()?.text).toBe('Should we dedup');

    select(reply, 3, 3);
    expect(getTextSelection()).toBeNull();
  });

  it('clears its own selection on unmount', () => {
    const { container, reply } = mountTranscript();
    const { unmount } = renderHook(() => useTranscriptSelectionContext({ current: container }, 's1'));
    select(reply, 0, 6);

    unmount();

    expect(getTextSelection()).toBeNull();
  });

  it("leaves a document's selection alone on unmount", () => {
    const { container } = mountTranscript();
    const { unmount } = renderHook(() => useTranscriptSelectionContext({ current: container }, 's1'));
    setTextSelection('document text', '/docs/plan.md');

    unmount();

    expect(getTextSelection()?.filePath).toBe('/docs/plan.md');
  });
});
