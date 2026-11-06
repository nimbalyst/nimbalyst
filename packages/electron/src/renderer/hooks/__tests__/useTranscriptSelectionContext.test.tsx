// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptViewMessage } from '@nimbalyst/runtime/ai/server/types';
import { useTranscriptSelectionContext } from '../useTranscriptSelectionContext';
import {
  clearTextSelection,
  getTextSelection,
  setTextSelection,
  transcriptSelectionKey,
} from '../../components/UnifiedAI/TextSelectionIndicator';

const messages = [
  { type: 'user_message', text: 'Can you **check** the plan?' },
  { type: 'tool_call', toolCall: { toolName: 'Write', toolDisplayName: 'Write', targetFilePath: '/ws/report.md', providerToolCallId: 't1' } },
  { type: 'assistant_message', text: 'Should we dedupe?' },
] as TranscriptViewMessage[];

// Mirrors TranscriptMessageRow: the tool call's own row is empty and its card
// is drawn inside the following assistant row.
function mountTranscript() {
  const container = document.createElement('div');
  container.innerHTML =
    '<div data-message-index="0"><div class="rich-transcript-message-header">You 10:08 AM</div>' +
    '<p>Can you check the plan?</p></div>' +
    '<div data-message-index="1"></div>' +
    '<div data-message-index="2"><div data-transcript-tool-index="1"><span>Write</span><pre># Bug report</pre></div>' +
    '<p>Should we dedupe?</p></div>';
  const outside = document.createElement('textarea');
  document.body.append(container, outside);
  const textOf = (selector: string) => container.querySelector(selector)!.firstChild as Text;
  return {
    container,
    outside,
    header: textOf('[data-message-index="0"] .rich-transcript-message-header'),
    question: textOf('[data-message-index="0"] p'),
    toolText: textOf('pre'),
    reply: textOf('[data-message-index="2"] p'),
  };
}

function select(start: Node, startOffset: number, end: Node = start, endOffset = startOffset, beforePublish?: () => void) {
  const range = document.createRange();
  range.setStart(start, startOffset);
  range.setEnd(end, endOffset);
  const selection = document.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  act(() => {
    document.dispatchEvent(new Event('selectionchange'));
    beforePublish?.();
    vi.advanceTimersByTime(200);
  });
}

let sid = '';

function mountHook(container: HTMLElement, sessionId = sid) {
  return renderHook(() => useTranscriptSelectionContext({ current: container }, sessionId, () => messages));
}

describe('useTranscriptSelectionContext', () => {
  beforeEach(() => {
    sid = `s-${Math.random()}`;
    vi.useFakeTimers();
    clearTextSelection();
  });

  afterEach(() => {
    vi.useRealTimers();
    clearTextSelection();
    document.body.innerHTML = '';
  });

  it('publishes the selected part of a reply, keyed to the session', () => {
    const { container, reply } = mountTranscript();
    mountHook(container);

    select(reply, 0, reply, 9);

    expect(getTextSelection()).toMatchObject({
      text: 'Should we',
      filePath: transcriptSelectionKey(sid),
      transcript: { author: 'assistant' },
    });
  });

  it('sends the markdown source when a whole message is selected, without its header', () => {
    const { container, header, question } = mountTranscript();
    mountHook(container);

    select(header, 0, question, question.length);

    expect(getTextSelection()).toMatchObject({ text: 'Can you **check** the plan?', transcript: { author: 'user' } });
  });

  it('labels each side of a selection spanning both, with tool cards as markers', () => {
    const { container, question, reply } = mountTranscript();
    mountHook(container);

    select(question, 8, reply, reply.length);

    expect(getTextSelection()?.transcript).toEqual({ author: 'mixed' });
    expect(getTextSelection()?.text).toBe(
      '[User]\ncheck the plan?\n\n[Your reply]\n[Tool call: Write (/ws/report.md)]\n\nShould we dedupe?',
    );
  });

  it('names the tool and file for a selection inside a tool card', () => {
    const { container, toolText } = mountTranscript();
    mountHook(container);

    select(toolText, 2, toolText, toolText.length);

    expect(getTextSelection()).toMatchObject({
      text: 'Bug report',
      transcript: { author: 'assistant', tool: { name: 'Write', filePath: '/ws/report.md' } },
    });
  });

  it('includes the starting message after the list unmounts its row mid-drag', () => {
    const { container, question, reply } = mountTranscript();
    mountHook(container);

    select(question, 0, reply, reply.length, () => {
      container.querySelector('[data-message-index="0"]')!.remove();
    });

    expect(getTextSelection()?.text).toMatch(/^\[User\]\nCan you \*\*check\*\* the plan\?/);
  });

  it('keeps the selection when focus moves outside the transcript, and clears on a click inside it', () => {
    const { container, reply, outside } = mountTranscript();
    mountHook(container);
    select(reply, 0, reply, 9);

    select(outside, 0);
    expect(getTextSelection()?.text).toBe('Should we');

    reply.parentElement!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    select(reply, 3);
    expect(getTextSelection()).toBeNull();
  });

  it('keeps the selection when the list unmounts the selected rows on scroll', () => {
    const { container, reply } = mountTranscript();
    mountHook(container);
    select(reply, 0, reply, 9);

    select(container, 0);

    expect(getTextSelection()?.text).toBe('Should we');
  });

  it('repaints the highlight when the list remounts a selected row', async () => {
    const highlights = new Map<string, { ranges: Range[] }>();
    vi.stubGlobal('CSS', { highlights });
    vi.stubGlobal('Highlight', class { ranges: Range[]; constructor(...ranges: Range[]) { this.ranges = ranges; } });
    try {
      const { container, question, reply } = mountTranscript();
      mountHook(container);
      select(question, 8, reply, 9);
      expect(highlights.get('transcript-selection')?.ranges.map(String)).toEqual(['check the plan?', '', 'Write# Bug reportShould we']);

      const oldRow = container.querySelector('[data-message-index="2"]')!;
      await act(async () => {
        oldRow.remove();
        await Promise.resolve();
        container.append(oldRow.cloneNode(true));
        await Promise.resolve();
        vi.advanceTimersByTime(100);
      });

      const ranges = highlights.get('transcript-selection')!.ranges;
      expect(ranges.map(String)).toEqual(['check the plan?', '', 'Write# Bug reportShould we']);
      expect(oldRow.contains(ranges[2].startContainer)).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps the selection when a button in the transcript is clicked', () => {
    const { container, reply } = mountTranscript();
    const button = document.createElement('button');
    container.append(button);
    mountHook(container);
    select(reply, 0, reply, 9);

    button.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    select(reply, 3);

    expect(getTextSelection()?.text).toBe('Should we');
  });

  it('takes its chip down on unmount and restores it when the session returns', () => {
    const { container, reply } = mountTranscript();
    const { unmount } = mountHook(container);
    select(reply, 0, reply, 6);

    unmount();
    expect(getTextSelection()).toBeNull();

    mountHook(container);
    expect(getTextSelection()).toMatchObject({
      text: 'Should',
      filePath: transcriptSelectionKey(sid),
      transcript: { author: 'assistant' },
    });
  });

  it('does not restore a selection the user removed', () => {
    const { container, reply } = mountTranscript();
    const { unmount } = mountHook(container);
    select(reply, 0, reply, 6);
    act(() => clearTextSelection());

    unmount();
    mountHook(container);

    expect(getTextSelection()).toBeNull();
  });

  it('still restores after a selection made elsewhere replaced it', () => {
    const { container, reply } = mountTranscript();
    const { unmount } = mountHook(container);
    select(reply, 0, reply, 6);
    act(() => setTextSelection('document text', '/docs/plan.md'));

    unmount();
    mountHook(container);

    expect(getTextSelection()?.text).toBe('Should');
  });

  it("leaves a document's selection alone on unmount", () => {
    const { container } = mountTranscript();
    const { unmount } = mountHook(container);
    setTextSelection('document text', '/docs/plan.md');

    unmount();

    expect(getTextSelection()?.filePath).toBe('/docs/plan.md');
  });
});
