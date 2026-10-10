// @vitest-environment node
import { createHeadlessEditor } from '@lexical/headless';
import type { Transformer } from '@lexical/markdown';
import { $getRoot } from 'lexical';
import { describe, expect, it } from 'vitest';

import HeadlessBodyNodes from '../../../nodes/headlessBodyNodes';
import { getHeadlessBodyTransformers } from '../../../markdown/headlessBodyTransformers';
import { $convertFromEnhancedMarkdownString } from '../../../markdown/EnhancedMarkdownImport';
import { $convertToEnhancedMarkdownString } from '../../../markdown/EnhancedMarkdownExport';
import { $isLayoutContainerNode, LayoutContainerNode } from '../LayoutContainerNode';
import { LayoutItemNode } from '../LayoutItemNode';
import { createLayoutTransformer } from '../LayoutTransformer';

const TRANSFORMERS: Transformer[] = [
  createLayoutTransformer(() => TRANSFORMERS),
  ...getHeadlessBodyTransformers(),
];

function roundTrip(markdown: string, inspect?: () => void): string {
  const editor = createHeadlessEditor({
    nodes: [...HeadlessBodyNodes, LayoutContainerNode, LayoutItemNode],
    onError: (error) => { throw error; },
  });
  editor.update(() => { $convertFromEnhancedMarkdownString(markdown, TRANSFORMERS); }, { discrete: true });
  let out = '';
  editor.getEditorState().read(() => {
    inspect?.();
    out = $convertToEnhancedMarkdownString(TRANSFORMERS, { includeFrontmatter: false });
  });
  return out;
}

const column = (...body: string[]) => ['<div data-column>', '', ...body, '', '</div>'];

describe('columns markdown', () => {
  it('round-trips two columns with headings and lists, keeping the template', () => {
    const md = [
      'Before',
      '',
      '<div data-columns="2fr 1fr">',
      ...column('## Left', '', 'Some **bold** text.'),
      ...column('- one', '- two'),
      '</div>',
      '',
      'After',
    ].join('\n');
    expect(roundTrip(md, () => {
      const container = $getRoot().getChildAtIndex(2);
      if (!$isLayoutContainerNode(container)) throw new Error('expected columns');
      expect(container.getTemplateColumns()).toBe('2fr 1fr');
      expect(container.getChildrenSize()).toBe(2);
    })).toBe(md);
  });

  it('round-trips three columns, an empty column, and a fenced </div> inside a column', () => {
    const md = [
      '<div data-columns="1fr 1fr 1fr">',
      ...column('```html', '</div>', '```'),
      '<div data-column>',
      '</div>',
      ...column('1. first', '2. second'),
      '</div>',
    ].join('\n');
    expect(roundTrip(md, () => {
      const container = $getRoot().getFirstChild();
      expect($isLayoutContainerNode(container) && container.getChildrenSize()).toBe(3);
    })).toBe(md);
  });

  it('leaves an unterminated wrapper as text instead of swallowing the page', () => {
    const md = '<div data-columns="1fr 1fr">\n<div data-column>\n\nlost?';
    expect(roundTrip(md, () => {
      expect($getRoot().getChildren().some($isLayoutContainerNode)).toBe(false);
    })).toContain('lost?');
  });

  // Each case once dropped text on the first round trip. The wrapper may stay
  // as text or become columns; what it may never do is lose a line.
  it.each([
    ['an inner <div> with trailing text', [
      '<div data-columns="1fr 1fr">', ...column('<div>inner', '</div>', 'LOST'), ...column('right'), '</div>', '', 'After',
    ]],
    ['a ~~~ line inside a backtick fence', [
      '<div data-columns="1fr 1fr">', ...column('```', '~~~', '</div>', '</div>', '```'), ...column('right'), '</div>', '', 'After',
    ]],
    ['text between column wrappers', [
      '<div data-columns="1fr 1fr">', ...column('left'), 'stray text', ...column('right'), '</div>', '', 'After',
    ]],
  ])('never discards content: %s', (_label, lines) => {
    const out = roundTrip(lines.join('\n'), () => {
      const last = $getRoot().getLastChild();
      expect(last?.getType()).toBe('paragraph');
      expect(last?.getTextContent()).toBe('After');
    });
    for (const line of lines) {
      if (line.trim()) expect(out).toContain(line);
    }
  });
});
