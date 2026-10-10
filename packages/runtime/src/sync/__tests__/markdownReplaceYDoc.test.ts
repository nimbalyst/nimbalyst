// @vitest-environment node
/**
 * The worker's page edit (`applyMarkdownReplacementsToLexicalYUpdate`,
 * shipped as `@nimbalyst/markdown-ydoc`) runs with the headless transformer
 * set only, no extension transformer store. A body's marks, citations and
 * relation links must come back byte-identical after an edit elsewhere, and
 * the edit must be a delta that merges with a teammate's concurrent one.
 */
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { createHumanCitation, formatCitationMarkdown } from '../../core/citationSyntax';
import {
  applyMarkdownReplacementsToLexicalYUpdate,
  lexicalYDocToMarkdown,
  markdownToLexicalYUpdate,
} from '../markdownYDoc';

const citation = formatCitationMarkdown(createHumanCitation({
  sessionId: 's-1',
  inputKind: 'prompt',
  key: 'k1',
  by: 'Greg Hinkle',
  email: 'greg@example.com',
  at: '2026-10-01T10:00:00Z',
  context: 'Prompt',
  quote: 'Ship the "CLI" first.',
}));
const MARK = '[We ship the CLI first.]{decided by="Greg Hinkle" email=greg@example.com on=2026-10-01 over="desktop first"}';
const REL_LINK = '[NIM-12](https://console.nimbalyst.com/org/o-1/project/p-1/page/item/NIM-12 "view=card rel=depends-on")';

const BODY = `# Plan

${MARK}

The parser was chosen after review.${citation}

Depends on ${REL_LINK}.

Last paragraph to edit.
`;

function merged(...updates: Uint8Array[]): Uint8Array {
  return Y.mergeUpdates(updates);
}

describe('applyMarkdownReplacementsToLexicalYUpdate', () => {
  const base = markdownToLexicalYUpdate(BODY);
  const canonical = lexicalYDocToMarkdown(base);

  it('keeps a mark, a human citation and a typed relation link byte-identical', () => {
    for (const piece of [MARK, citation, REL_LINK]) expect(canonical).toContain(piece);

    const update = applyMarkdownReplacementsToLexicalYUpdate(base, [
      { oldText: 'Last paragraph to edit.', newText: 'Last paragraph, edited.' },
    ]);
    expect(lexicalYDocToMarkdown(merged(base, update)))
      .toBe(canonical.replace('Last paragraph to edit.', 'Last paragraph, edited.'));
  });

  it('is a delta: a concurrent edit elsewhere survives the merge', () => {
    const mine = applyMarkdownReplacementsToLexicalYUpdate(base, [
      { oldText: 'Last paragraph to edit.', newText: 'Last paragraph, edited.' },
    ]);
    const theirs = applyMarkdownReplacementsToLexicalYUpdate(base, [
      { oldText: 'The parser was chosen after review.', newText: 'The parser was chosen after a long review.' },
    ]);
    expect(lexicalYDocToMarkdown(merged(base, mine, theirs))).toBe(
      canonical
        .replace('Last paragraph to edit.', 'Last paragraph, edited.')
        .replace('The parser was chosen after review.', 'The parser was chosen after a long review.'),
    );
  });

  it('fails on text that is not in the body, changing nothing', () => {
    expect(() => applyMarkdownReplacementsToLexicalYUpdate(base, [{ oldText: 'Not in the page', newText: 'x' }]))
      .toThrow(/not found/i);
  });
});
