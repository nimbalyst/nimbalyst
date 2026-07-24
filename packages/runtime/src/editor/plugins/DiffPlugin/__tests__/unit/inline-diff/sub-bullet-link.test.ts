/**
 * Regression: list items containing a mix of plain text and a link should
 * diff per child rather than dragging the whole bullet into the block
 * fallback. Without per-child diffing, "URL: [old](old-url)" -> "URL: [new]
 * (new-url)" used to show the entire bullet line red and the entire bullet
 * line green; or, in the URL-only-change variant, the change was silently
 * applied with no diff markers at all because the container's identity check
 * compared only top-level text and ignored link URL/children differences.
 *
 * After the inline-diff fix:
 *   - "URL: " stays plain (unchanged)
 *   - the changed link is shown as a removed/added pair side-by-side
 *   - approve and reject both round-trip cleanly
 */

import {describe, expect, it} from 'vitest';
import {testComprehensiveDiff} from '../../utils/comprehensiveDiffTester';
import {$getRoot, $isElementNode, type LexicalEditor, type LexicalNode} from 'lexical';
import {$getDiffState} from '../../../core/DiffState';

function collectDiffStates(
  editor: LexicalEditor,
): {removed: string[]; added: string[]} {
  return editor.getEditorState().read(() => {
    const root = $getRoot();
    const removed: string[] = [];
    const added: string[] = [];
    function walk(node: LexicalNode) {
      const ds = $getDiffState(node);
      if (ds === 'removed') removed.push(node.getTextContent());
      if (ds === 'added') added.push(node.getTextContent());
      if ($isElementNode(node)) {
        for (const c of node.getChildren()) walk(c);
      }
    }
    for (const c of root.getChildren()) walk(c);
    return {removed, added};
  });
}

describe('Inline diff - sub-bullet with link', () => {
  it('link URL change with stable link text -- "URL: " stays plain, link shown as paired remove/add', () => {
    const oldMarkdown = `- Test
  - URL: [stable text](https://example.com/old)`;
    const newMarkdown = `- Test
  - URL: [stable text](https://example.com/new)`;

    const result = testComprehensiveDiff(oldMarkdown, newMarkdown);
    const {removed, added} = collectDiffStates(result.withDiff.editor);

    // The link change must be visible in the diff -- never silently applied.
    expect(removed.length).toBeGreaterThan(0);
    expect(added.length).toBeGreaterThan(0);

    // The change should not poison the "URL: " prefix; "URL: " (with its
    // trailing space) is plain text and should not appear in either set.
    expect(removed.some((t) => t.includes('URL: '))).toBe(false);
    expect(added.some((t) => t.includes('URL: '))).toBe(false);

    expect(result.acceptMatchesNew.matches).toBe(true);
    expect(result.rejectMatchesOld.matches).toBe(true);
  });

  it('link text and url both change -- only the link flashes, plain prefix is preserved', () => {
    const oldMarkdown = `- Test Links
  - URL: [https://example.com/test-link](https://example.com/test-link)
  - URL: [https://example.com/test-link2](https://example.com/test-link2)`;
    const newMarkdown = `- Test Links
  - URL: [https://example.com/test-link](https://example.com/test-link)
  - URL: [https://example.com/test-link3](https://example.com/test-link3)`;

    const result = testComprehensiveDiff(oldMarkdown, newMarkdown);
    const {removed, added} = collectDiffStates(result.withDiff.editor);

    // The unchanged sub-bullet (test-link) must not show diff markers.
    expect(removed.some((t) => t.includes('test-link') && !t.includes('test-link2'))).toBe(false);
    expect(added.some((t) => t.includes('test-link') && !t.includes('test-link3'))).toBe(false);

    // The changed sub-bullet's plain-text prefix must stay plain.
    expect(removed.some((t) => t.includes('URL: '))).toBe(false);
    expect(added.some((t) => t.includes('URL: '))).toBe(false);

    expect(result.acceptMatchesNew.matches).toBe(true);
    expect(result.rejectMatchesOld.matches).toBe(true);
  });

  it('text around an unchanged link changes -- link stays plain, text is word-level diffed', () => {
    const oldMarkdown = `- Visit [the docs](https://example.com) for info.`;
    const newMarkdown = `- Read [the docs](https://example.com) for help.`;

    const result = testComprehensiveDiff(oldMarkdown, newMarkdown);
    const {removed, added} = collectDiffStates(result.withDiff.editor);

    // The unchanged link should not be in either diff set.
    expect(removed.some((t) => t === 'the docs')).toBe(false);
    expect(added.some((t) => t === 'the docs')).toBe(false);

    expect(result.acceptMatchesNew.matches).toBe(true);
    expect(result.rejectMatchesOld.matches).toBe(true);
  });

  it('placeholder bullet ("**URL:**" alone) gets URL appended -- shared prefix stays plain, only the new content flashes', () => {
    const oldMarkdown = `- Item
  - **URL:**`;
    const newMarkdown = `- Item
  - **URL:** https://en.wikipedia.org/wiki/Texas`;

    const result = testComprehensiveDiff(oldMarkdown, newMarkdown);
    const {removed, added} = collectDiffStates(result.withDiff.editor);

    // The shared "URL:" prefix must stay plain in both directions.
    expect(removed.some((t) => t.trim() === 'URL:')).toBe(false);
    expect(added.some((t) => t.trim() === 'URL:')).toBe(false);

    // Some new content (the appended URL) must be marked as added.
    expect(added.length).toBeGreaterThan(0);

    expect(result.acceptMatchesNew.matches).toBe(true);
    expect(result.rejectMatchesOld.matches).toBe(true);
  });
});
