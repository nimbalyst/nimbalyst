import { useEffect, useRef, type RefObject } from 'react';
import type { TranscriptViewMessage } from '@nimbalyst/runtime/ai/server/types';
import {
  setTextSelection,
  clearTextSelection,
  getTextSelection,
  getTranscriptSelection,
  transcriptSelectionKey,
} from '../components/UnifiedAI/TextSelectionIndicator';
import type { TranscriptSelectionSource } from '@nimbalyst/runtime';
import { assembleTranscriptSelection, tidySelectionText, toolCallMarker, toolFilePath } from './transcriptSelectionText';

const SELECTION_DEBOUNCE_MS = 150;
const ROW = '[data-message-index]';
const TOOL_CARD = '[data-transcript-tool-index]';
/** Interface text inside a row that is not part of the message. */
const CHROME = '.rich-transcript-message-header, .rich-transcript-message-copy-action, .rich-transcript-turn-elapsed, button';
const HIGHLIGHT = 'transcript-selection';

// One selection slot is shared by every session, so only the session that
// painted the highlight may remove it.
let highlightOwner: string | null = null;

// A session's panel unmounts when the user switches away. Its selection is
// kept here and restored on return, the way a document editor keeps its own
// selection and republishes it when its tab is reactivated.
const savedSelections = new Map<string, { text: string; transcript?: TranscriptSelectionSource }>();

/** A selection end as a message row and a character offset into that row's text. */
interface Anchor {
  index: number;
  offset: number;
}

// The list unmounts rows scrolled out of view and remounts them as new
// elements, so the painted highlight is kept as row offsets and repainted.
const savedAnchors = new Map<string, { start: Anchor; end: Anchor }>();

function highlightsSupported(): boolean {
  return typeof CSS !== 'undefined' && !!CSS.highlights && typeof Highlight !== 'undefined';
}

function paintHighlight(ranges: Range[], owner: string): void {
  if (!highlightsSupported()) return;
  if (!document.getElementById('transcript-selection-highlight-style')) {
    const style = document.createElement('style');
    style.id = 'transcript-selection-highlight-style';
    // Same system colour the document editor keeps on an unfocused selection.
    style.textContent = `::highlight(${HIGHLIGHT}) { background-color: Highlight; }`;
    document.head.appendChild(style);
  }
  CSS.highlights.set(HIGHLIGHT, new Highlight(...ranges));
  highlightOwner = owner;
}

function clearHighlight(owner: string): void {
  if (highlightOwner !== owner || !highlightsSupported()) return;
  CSS.highlights.delete(HIGHLIGHT);
  highlightOwner = null;
}

function offsetInRow(row: Element, node: Node, offset: number): number {
  const before = document.createRange();
  before.setStart(row, 0);
  before.setEnd(node, offset);
  return before.toString().length;
}

/** The text position `offset` characters into `row`, or its end when past it. */
function pointInRow(row: Element, offset: number): [Node, number] {
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  let seen = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = (node as Text).length;
    if (offset <= seen + length) return [node, offset - seen];
    seen += length;
  }
  return [row, row.childNodes.length];
}

function anchorsOf(range: Range, startIndex: number, endIndex: number, container: Element): { start: Anchor; end: Anchor } {
  const rowOf = (index: number) => container.querySelector(`[data-message-index="${index}"]`);
  const startRow = rowOf(startIndex);
  const endRow = rowOf(endIndex);
  return {
    start: {
      index: startIndex,
      offset: startRow?.contains(range.startContainer) ? offsetInRow(startRow, range.startContainer, range.startOffset) : 0,
    },
    end: {
      index: endIndex,
      offset: endRow?.contains(range.endContainer) ? offsetInRow(endRow, range.endContainer, range.endOffset) : Infinity,
    },
  };
}

/** Paint the session's selection over whichever of its rows are mounted now. */
function repaintHighlight(container: Element, sessionId: string): void {
  const anchors = savedAnchors.get(sessionId);
  if (!anchors || !getTranscriptSelection(sessionId)) return;
  const ranges: Range[] = [];
  container.querySelectorAll(ROW).forEach((row) => {
    const index = Number(row.getAttribute('data-message-index'));
    if (index < anchors.start.index || index > anchors.end.index) return;
    const range = document.createRange();
    range.selectNodeContents(row);
    if (index === anchors.start.index) range.setStart(...pointInRow(row, anchors.start.offset));
    if (index === anchors.end.index) range.setEnd(...pointInRow(row, anchors.end.offset));
    ranges.push(range);
  });
  paintHighlight(ranges, sessionId);
}

function elementOf(node: Node | null): Element | null {
  return node instanceof Element ? node : node?.parentElement ?? null;
}

function rowIndexOf(node: Node | null): number | undefined {
  const value = elementOf(node)?.closest(ROW)?.getAttribute('data-message-index');
  return value == null ? undefined : Number(value);
}

/**
 * Visible text of a range, without interface chrome, and with each tool card
 * replaced by a one-line marker naming the tool.
 */
function renderedText(
  range: Range,
  messages: readonly TranscriptViewMessage[],
  { keepToolCards = false } = {},
): string {
  const holder = document.createElement('div');
  holder.style.cssText = 'position:fixed;left:-100000px;top:0;white-space:pre-wrap;';
  holder.append(range.cloneContents());
  holder.querySelectorAll(CHROME).forEach((el) => el.remove());
  if (!keepToolCards) holder.querySelectorAll(TOOL_CARD).forEach((el) => {
    const tool = messages[Number(el.getAttribute('data-transcript-tool-index'))];
    el.replaceWith(tool?.toolCall ? `\n${toolCallMarker(tool)}\n` : '');
  });
  document.body.append(holder);
  // innerText keeps line breaks between blocks; jsdom has only textContent.
  const text = holder.innerText ?? holder.textContent ?? '';
  holder.remove();
  // innerText puts several blank lines between rendered paragraphs.
  return text.replace(/\n{3,}/g, '\n\n');
}

function clipTo(range: Range, el: Element): Range {
  const clipped = document.createRange();
  clipped.selectNodeContents(el);
  if (range.compareBoundaryPoints(Range.START_TO_START, clipped) > 0) {
    clipped.setStart(range.startContainer, range.startOffset);
  }
  if (range.compareBoundaryPoints(Range.END_TO_END, clipped) < 0) {
    clipped.setEnd(range.endContainer, range.endOffset);
  }
  return clipped;
}

const squash = (text: string) => text.replace(/\s+/g, '');

/**
 * Publishes text the user selects in a session's chat transcript into the AI
 * selection-context store, so it reaches the agent the same way a document
 * selection does (the "Selection" chip above the input), and keeps it painted
 * while the chip is attached, including after its rows scroll away and back.
 *
 * Semantics mirror useLexicalSelectionContext: selections outside the
 * transcript are ignored (so clicking into the input keeps the chip), a
 * collapsed click inside the transcript clears it. On unmount (switching
 * sessions) the chip is taken down and restored when the session returns.
 */
export function useTranscriptSelectionContext(
  containerRef: RefObject<HTMLElement | null>,
  sessionId: string,
  getMessages: () => readonly TranscriptViewMessage[],
): void {
  const getMessagesRef = useRef(getMessages);
  getMessagesRef.current = getMessages;

  useEffect(() => {
    const key = transcriptSelectionKey(sessionId);
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    // A drag that scrolls the list unmounts the row it started in, and the
    // browser then moves that end of the range out of any row, so the row is
    // remembered while it is still mounted.
    let anchorIndex: number | undefined;
    let clickedInTranscript = false;
    const onPointerDown = (event: PointerEvent) => {
      // Buttons (scroll-to-bottom, copy, collapse) act on the transcript without deselecting.
      const target = event.target as Element;
      clickedInTranscript = !!containerRef.current?.contains(target) && !target.closest?.('button, [role="button"]');
    };

    const publish = () => {
      const container = containerRef.current;
      const selection = document.getSelection();
      if (!container || !selection || selection.rangeCount === 0) return;
      const range = selection.getRangeAt(0);
      if (!container.contains(range.commonAncestorContainer)) return;
      // Text fields inside the transcript (e.g. search) have their own selection.
      if (elementOf(range.startContainer)?.closest('input, textarea, [contenteditable="true"]')) return;

      if (range.collapsed || !selection.toString().trim()) {
        // The browser also collapses the selection when the list unmounts the
        // selected rows on scroll; only a click in the transcript clears it.
        if (clickedInTranscript) clearTextSelection(key);
        clickedInTranscript = false;
        return;
      }
      clickedInTranscript = false;

      const messages = getMessagesRef.current();
      const toolCard = elementOf(range.startContainer)?.closest(TOOL_CARD);
      if (toolCard && toolCard.contains(range.endContainer)) {
        const message = messages[Number(toolCard.getAttribute('data-transcript-tool-index'))];
        const tool = message?.toolCall;
        const text = tidySelectionText(renderedText(range, messages, { keepToolCards: true }));
        if (!text) return;
        const index = rowIndexOf(toolCard);
        if (index !== undefined) savedAnchors.set(sessionId, anchorsOf(range, index, index, container));
        setTextSelection(text, key, {
          author: 'assistant',
          tool: tool ? { name: tool.toolDisplayName || tool.toolName, filePath: toolFilePath(message) } : undefined,
        });
        repaintHighlight(container, sessionId);
        return;
      }

      const mounted = Array.from(container.querySelectorAll(ROW))
        .filter((row) => range.intersectsNode(row))
        .map((row) => Number(row.getAttribute('data-message-index')));
      const startIndex = rowIndexOf(range.startContainer) ?? Math.min(anchorIndex ?? Infinity, ...mounted);
      const endIndex = rowIndexOf(range.endContainer) ?? Math.max(anchorIndex ?? -Infinity, ...mounted);
      if (!Number.isFinite(startIndex) || !Number.isFinite(endIndex)) return;

      const slice = (index: number) => {
        const row = container.querySelector(`[data-message-index="${index}"]`);
        const type = messages[index]?.type;
        if (!row) return { index };
        const selected = renderedText(clipTo(range, row), messages);
        const all = document.createRange();
        all.selectNodeContents(row);
        const whole = squash(selected) === squash(renderedText(all, messages));
        // Only user and assistant rows have a markdown source to fall back on.
        return whole && (type === 'user_message' || type === 'assistant_message') ? { index } : { index, partialText: selected };
      };

      const result = assembleTranscriptSelection(messages, slice(startIndex), slice(endIndex));
      if (!result) return;
      savedAnchors.set(sessionId, anchorsOf(range, startIndex, endIndex, container));
      setTextSelection(result.text, key, { author: result.author });
      repaintHighlight(container, sessionId);
    };

    const onSelectionChange = () => {
      const selection = document.getSelection();
      if (!selection || selection.isCollapsed) anchorIndex = undefined;
      else anchorIndex = rowIndexOf(selection.anchorNode) ?? anchorIndex;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(publish, SELECTION_DEBOUNCE_MS);
    };

    const onStoreChange = () => {
      const current = getTranscriptSelection(sessionId);
      if (current) {
        savedSelections.set(sessionId, { text: current.text, transcript: current.transcript });
        return;
      }
      clearHighlight(sessionId);
      // An empty slot means the user dropped this selection (chip × or a click
      // in the transcript). A selection made elsewhere leaves it saved.
      if (!getTextSelection()) {
        savedSelections.delete(sessionId);
        savedAnchors.delete(sessionId);
      }
    };

    let repaintTimer: ReturnType<typeof setTimeout> | null = null;
    const observer = new MutationObserver(() => {
      if (repaintTimer) clearTimeout(repaintTimer);
      repaintTimer = setTimeout(() => {
        if (containerRef.current) repaintHighlight(containerRef.current, sessionId);
      }, 50);
    });
    if (containerRef.current) observer.observe(containerRef.current, { childList: true, subtree: true });

    const saved = savedSelections.get(sessionId);
    if (saved) {
      setTextSelection(saved.text, key, saved.transcript);
      if (containerRef.current) repaintHighlight(containerRef.current, sessionId);
    }

    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('selectionchange', onSelectionChange);
    window.addEventListener('text-selection-changed', onStoreChange);
    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      if (repaintTimer) clearTimeout(repaintTimer);
      observer.disconnect();
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('selectionchange', onSelectionChange);
      window.removeEventListener('text-selection-changed', onStoreChange);
      clearTextSelection(key);
      clearHighlight(sessionId);
    };
  }, [containerRef, sessionId]);
}
