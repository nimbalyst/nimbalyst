// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createHeadlessEditor } from '@lexical/headless';
import { $getRoot, $isElementNode, $isTextNode, type LexicalNode, type TextNode } from 'lexical';

import HeadlessBodyNodes from '../../../nodes/headlessBodyNodes';
import { getHeadlessBodyTransformers } from '../../../markdown/headlessBodyTransformers';
import { $convertFromEnhancedMarkdownString } from '../../../markdown/EnhancedMarkdownImport';
import { $convertToEnhancedMarkdownString } from '../../../markdown/EnhancedMarkdownExport';
import { $markSelection, $removePageMark, $updatePageMark } from '../pageMarkActions';
import { $isPageMarkNode } from '../PageMarkNode';

const transformers = getHeadlessBodyTransformers();

function textNodes(): TextNode[] {
  const out: TextNode[] = [];
  const visit = (node: LexicalNode) => {
    if ($isTextNode(node)) out.push(node);
    else if ($isElementNode(node)) node.getChildren().forEach(visit);
  };
  visit($getRoot());
  return out;
}

function run(markdown: string, act: () => void): string {
  const editor = createHeadlessEditor({ nodes: [...HeadlessBodyNodes], onError: (error) => { throw error; } });
  editor.update(() => $convertFromEnhancedMarkdownString(markdown, transformers, undefined, true, false), { discrete: true });
  editor.update(act, { discrete: true });
  return editor.getEditorState().read(() => $convertToEnhancedMarkdownString(transformers, { includeFrontmatter: false }));
}

describe('page mark commands', () => {
  it('marks a selection that ends inside a link by taking the whole link', () => {
    const out = run('Use [Flagship](https://f.dev) for flags.', () => {
      const [before, linkText] = textNodes();
      before.select(4, 4).focus.set(linkText.getKey(), 4, 'text');
      expect($markSelection({ kind: 'decided', by: 'Greg', on: '2026-09-30' })).not.toBeNull();
    });
    expect(out).toBe('Use [[Flagship](https://f.dev)]{decided by="Greg" on=2026-09-30} for flags.');
  });

  it('refuses a selection across two paragraphs', () => {
    const out = run('One.\n\nTwo.', () => {
      const [one, two] = textNodes();
      one.select(0, 0).focus.set(two.getKey(), 2, 'text');
      expect($markSelection({ kind: 'open' })).toBeNull();
    });
    expect(out).toBe('One.\n\nTwo.');
  });

  it('updates and removes a mark, keeping its sentence', () => {
    const markdown = 'A [b **c**]{open by=x} d';
    expect(run(markdown, () => {
      const mark = $getRoot().getFirstDescendant()!.getNextSibling()!;
      expect($isPageMarkNode(mark)).toBe(true);
      $updatePageMark(mark.getKey(), { kind: 'decided', by: 'Ana', over: 'b' });
    })).toBe('A [b **c**]{decided by="Ana" over="b"} d');
    expect(run(markdown, () => {
      const mark = $getRoot().getFirstDescendant()!.getNextSibling()!;
      $removePageMark(mark.getKey());
    })).toBe('A b **c** d');
  });
});
