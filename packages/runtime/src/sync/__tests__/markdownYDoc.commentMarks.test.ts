// @vitest-environment node
/**
 * Comment marks must not change a body's markdown.
 *
 * Markdown has no syntax for a comment, and the collab server compares the
 * exported markdown against its own last write to decide whether a team-side
 * edit happened (`body_edited`). A mark that shifts the export, as one inside
 * a bold run did (`**beta gamma**` exported as `****beta** gamma**`), makes
 * every publish refuse a page someone merely commented on.
 */
import { $isMarkNode, $wrapSelectionInMarkNode } from '@lexical/mark';
import { $createRangeSelection, $getRoot, $isElementNode, $setSelection, type LexicalNode } from 'lexical';
import { describe, expect, it } from 'vitest';
import { applyUpdate, Doc, encodeStateAsUpdate } from 'yjs';

import { HeadlessBodyNodes } from '../../editor/nodes/headlessBodyNodes';
import {
  applyMarkdownReplacementsToLexicalYUpdate,
  lexicalYDocToMarkdown,
  markdownToLexicalYUpdate,
} from '../markdownYDoc';
import { withHeadlessLexicalBridge } from '../withHeadlessLexicalBridge';

/** The body's state with a comment mark wrapped around `quote`, as an editor client writes it. */
function stateWithMark(markdown: string, quote: string): Uint8Array {
  const doc = new Doc();
  try {
    applyUpdate(doc, markdownToLexicalYUpdate(markdown));
    withHeadlessLexicalBridge(doc, { nodes: HeadlessBodyNodes }, (headless) => {
      headless.applyUpdate(() => {
        const texts = $getRoot().getAllTextNodes();
        const full = texts.map((node) => node.getTextContent()).join('');
        const start = full.indexOf(quote);
        if (start < 0) throw new Error(`"${quote}" is not in the body`);
        const end = start + quote.length;
        let at = 0;
        let anchor: { key: string; offset: number } | null = null;
        let focus: { key: string; offset: number } | null = null;
        for (const node of texts) {
          const size = node.getTextContentSize();
          if (!anchor && start < at + size) anchor = { key: node.getKey(), offset: start - at };
          if (!focus && end <= at + size) focus = { key: node.getKey(), offset: end - at };
          at += size;
        }
        const selection = $createRangeSelection();
        selection.anchor.set(anchor!.key, anchor!.offset, 'text');
        selection.focus.set(focus!.key, focus!.offset, 'text');
        $setSelection(selection);
        $wrapSelectionInMarkNode(selection, false, 'thread-1');
      });
    });
    return encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
}

const CASES: Array<[label: string, markdown: string, quote: string]> = [
  ['plain', 'Alpha beta gamma delta.\n\nSecond paragraph here.\n', 'beta gamma'],
  ['part of a bold run', 'Alpha **beta gamma** delta.\n', 'beta'],
  ['across a bold boundary', 'Alpha **beta gamma** delta.\n', 'pha beta ga'],
  ['a whole bold run', 'Alpha **beta gamma** delta.\n', 'beta gamma'],
  ['part of inline code', 'Run `nim wiki publish` today.\n', 'nim wiki'],
  ['link text', 'See [the docs](https://example.com) now.\n', 'the docs'],
  ['heading', '# Big title here\n\nBody.\n', 'title'],
  ['list item', '- one item\n- two item\n', 'two item'],
  ['table cell', '| a | b |\n| --- | --- |\n| cell one | cell two |\n', 'cell one'],
  ['across paragraphs', 'First para end.\n\nSecond para start.\n', 'end.Second'],
];

describe('headless markdown export with comment marks', () => {
  it.each(CASES)('exports %s byte-identically with and without a mark', (_label, markdown, quote) => {
    const without = lexicalYDocToMarkdown(markdownToLexicalYUpdate(markdown));
    expect(lexicalYDocToMarkdown(stateWithMark(markdown, quote))).toBe(without);
  });
});

/** Comment ids of every mark in the body. */
function markIds(state: Uint8Array): string[] {
  const doc = new Doc();
  try {
    applyUpdate(doc, state);
    return withHeadlessLexicalBridge(doc, { nodes: HeadlessBodyNodes }, (headless) =>
      headless.editor.getEditorState().read(() => {
        const ids: string[] = [];
        const visit = (node: LexicalNode) => {
          if ($isMarkNode(node)) ids.push(...node.getIDs());
          if ($isElementNode(node)) node.getChildren().forEach(visit);
        };
        visit($getRoot());
        return ids;
      }),
    );
  } finally {
    doc.destroy();
  }
}

function replaceIn(state: Uint8Array, oldText: string, newText: string): Uint8Array {
  const doc = new Doc();
  try {
    applyUpdate(doc, state);
    applyUpdate(doc, applyMarkdownReplacementsToLexicalYUpdate(state, [{ oldText, newText }]));
    return encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
}

/**
 * The replacement's `oldText` is matched against the body's export, so a mark
 * that split a format run made text the agent read from a clean export
 * unmatchable, and an edit elsewhere re-parsed the split run as written.
 */
const REPLACE_CASES: Array<[label: string, markdown: string, quote: string, oldText: string, newText: string, expected: string]> = [
  ['beside a mark inside bold', 'Alpha **beta gamma** delta.\n', 'beta', 'delta.', 'omega.', 'Alpha **beta gamma** omega.\n'],
  ['of a bold run holding a mark', 'Alpha **beta gamma** delta.\n', 'beta', '**beta gamma** delta', '**beta gamma** epsilon', 'Alpha **beta gamma** epsilon.\n'],
  ['beside a mark inside inline code', 'Run `nim wiki publish` today.\n', 'nim wiki', 'today', 'now', 'Run `nim wiki publish` now.\n'],
];

describe('headless markdown replace with comment marks', () => {
  it.each(REPLACE_CASES)('replaces text %s and keeps the mark', (_label, markdown, quote, oldText, newText, expected) => {
    const after = replaceIn(stateWithMark(markdown, quote), oldText, newText);
    expect(lexicalYDocToMarkdown(after)).toBe(expected);
    expect(markIds(after)).toContain('thread-1');
  });
});
