// @vitest-environment node
import { createHeadlessEditor } from '@lexical/headless';
import type { Transformer } from '@lexical/markdown';
import { $getRoot } from 'lexical';
import { describe, expect, it } from 'vitest';

import HeadlessBodyNodes from '../../../nodes/headlessBodyNodes';
import { getHeadlessBodyTransformers } from '../../../markdown/headlessBodyTransformers';
import { $convertFromEnhancedMarkdownString } from '../../../markdown/EnhancedMarkdownImport';
import { $convertToEnhancedMarkdownString } from '../../../markdown/EnhancedMarkdownExport';
import { $isTocNode, parseTocDepth, setTocDepth, TOC_TRANSFORMER, TocNode } from '../TocNodeCore';
import { $getTocHeadings } from '../tocHeadings';
import { LayoutContainerNode } from '../../LayoutPlugin/LayoutContainerNode';
import { LayoutItemNode } from '../../LayoutPlugin/LayoutItemNode';
import { createLayoutTransformer } from '../../LayoutPlugin/LayoutTransformer';

const TRANSFORMERS: Transformer[] = [
  TOC_TRANSFORMER,
  createLayoutTransformer(() => TRANSFORMERS),
  ...getHeadlessBodyTransformers(),
];

function load(markdown: string) {
  const editor = createHeadlessEditor({ nodes: [...HeadlessBodyNodes, TocNode, LayoutContainerNode, LayoutItemNode], onError: (error) => { throw error; } });
  editor.update(() => { $convertFromEnhancedMarkdownString(markdown, TRANSFORMERS); }, { discrete: true });
  return editor;
}

function roundTrip(markdown: string): string {
  return load(markdown).getEditorState().read(() => $convertToEnhancedMarkdownString(TRANSFORMERS, { includeFrontmatter: false }));
}

describe('toc block', () => {
  it.each([
    ['a bare fence', '# Title\n\n```toc\n```\n\n## Section'],
    ['a depth and an unknown key', '```toc\ndepth: 2\ntitle: On this page\n```\n\nAfter'],
  ])('round-trips %s byte for byte', (_label, md) => {
    load(md).getEditorState().read(() => {
      expect($getRoot().getChildren().some($isTocNode)).toBe(true);
    });
    expect(roundTrip(md)).toBe(md);
  });

  it('reads depth with a default of 3, and edits only the depth line', () => {
    expect(parseTocDepth('')).toBe(3);
    expect(parseTocDepth('depth: 9')).toBe(3);
    expect(parseTocDepth('title: x\ndepth: 2')).toBe(2);
    expect(setTocDepth('title: x\ndepth: 2', 4)).toBe('title: x\ndepth: 4');
    expect(setTocDepth('title: x', 1)).toBe('depth: 1\ntitle: x');
    expect(setTocDepth('', 2)).toBe('depth: 2');
  });

  it('lists headings to the depth, with anchor slugs matching HeadingAnchorExtension, including nested ones', () => {
    const editor = load([
      '# Intro',
      '## Setup',
      '### Deep detail',
      '#### Too deep',
      '<div data-columns="1fr 1fr">',
      '<div data-column>',
      '',
      '## Setup',
      '',
      '</div>',
      '</div>',
    ].join('\n'));
    const headings = editor.getEditorState().read(() => $getTocHeadings(3));
    expect(headings.map(({ text, level, slug }) => [text, level, slug])).toEqual([
      ['Intro', 1, 'intro'],
      ['Setup', 2, 'setup'],
      ['Deep detail', 3, 'deep-detail'],
      ['Setup', 2, 'setup-1'],
    ]);
  });
});
