// @vitest-environment node
import { createHeadlessEditor } from '@lexical/headless';
import { $getRoot, type LexicalEditor } from 'lexical';
import { describe, expect, it } from 'vitest';

import HeadlessBodyNodes from '../../../nodes/headlessBodyNodes';
import { getHeadlessBodyTransformers } from '../../../markdown/headlessBodyTransformers';
import { $convertFromEnhancedMarkdownString } from '../../../markdown/EnhancedMarkdownImport';
import { $convertToEnhancedMarkdownString } from '../../../markdown/EnhancedMarkdownExport';
import { fenceRoundTrip } from '../../fencedBlock/__tests__/fenceRoundTrip';
import { $addTab, $deleteTab, $isTabsNode, $moveTab, type TabsNode } from '../TabsNodes';

const panel = (attrs: string, summary: string, ...body: string[]) => [
  `<details${attrs}>`,
  `<summary>${summary}</summary>`,
  ...(body.length ? ['', ...body, ''] : []),
  '</details>',
];

describe('tabs markdown', () => {
  it('round-trips panels with block content, keeping unknown attributes and summary HTML', () => {
    const md = [
      'Before',
      '',
      '<div data-tabs class="wide" id="api">',
      ...panel(' data-tab open', 'Overview', '## Heading', '', 'Some **bold** text.'),
      ...panel(' data-tab data-x="1"', 'A &amp; B', '- one', '- two'),
      ...panel(' data-tab', 'Empty'),
      '</div>',
      '',
      'After',
    ].join('\n');
    const trip = fenceRoundTrip(md);
    expect(trip.errors).toEqual([]);
    expect(trip.blockTypes.filter((type) => type === 'tabs')).toHaveLength(1);
    expect(trip.exported).toBe(md);
    expect(trip.reexported).toBe(md);
  });

  it('keeps fenced closing tags, nested collapsibles and nested blocks inside a panel', () => {
    const md = [
      '<div data-tabs>',
      ...panel(' data-tab', 'Code', '```html', '</details>', '</div>', '```', '', '```chart', 'type: bar', '```'),
      ...panel(' data-tab', 'Nested', '<div data-columns="1fr 1fr">', '<div data-column>', '', 'left', '', '</div>', '<div data-column>', '', 'right', '', '</div>', '</div>'),
      '</div>',
    ].join('\n');
    const trip = fenceRoundTrip(md);
    expect(trip.errors).toEqual([]);
    expect(trip.blockTypes).toEqual(['tabs']);
    expect(trip.exported).toBe(md);
  });

  it.each([
    ['unterminated', ['<div data-tabs>', ...panel(' data-tab', 'A', 'kept')]],
    ['text between panels', ['<div data-tabs>', ...panel(' data-tab', 'A', 'one'), 'stray text', ...panel(' data-tab', 'B', 'two'), '</div>']],
    ['a panel without a summary line', ['<div data-tabs>', '<details data-tab>', '', 'body', '', '</details>', '</div>']],
    ['a closing tag that would end the panel mid-content', ['<div data-tabs>', ...panel(' data-tab', 'A', 'text </details> more'), '</div>']],
    ['no panels', ['<div data-tabs>', '</div>']],
  ])('refuses to consume the wrapper when that could drop content: %s', (_name, lines) => {
    const md = lines.join('\n');
    const trip = fenceRoundTrip(md);
    expect(trip.blockTypes).not.toContain('tabs');
    // Every word of the input survives the import as ordinary content.
    for (const word of ['kept', 'one', 'two', 'stray', 'body', 'more'].filter((w) => md.includes(w))) {
      expect(trip.exported).toContain(word);
    }
  });
});

describe('tab operations', () => {
  const md = ['<div data-tabs>', ...panel(' data-tab', 'One', 'first'), ...panel(' data-tab', 'Two', 'second'), '</div>'].join('\n');

  function withTabs(run: (tabs: TabsNode) => void): string {
    const transformers = getHeadlessBodyTransformers();
    const editor: LexicalEditor = createHeadlessEditor({ nodes: [...HeadlessBodyNodes], onError: (error) => { throw error; } });
    editor.update(() => { $convertFromEnhancedMarkdownString(md, transformers, undefined, true, false); }, { discrete: true });
    editor.update(() => {
      const tabs = $getRoot().getChildren().find($isTabsNode);
      if (!tabs) throw new Error('expected tabs');
      run(tabs);
    }, { discrete: true });
    return editor.getEditorState().read(() => $convertToEnhancedMarkdownString(transformers, { includeFrontmatter: false, shouldPreserveNewLines: true }));
  }

  it('adds a uniquely named empty tab, renames with HTML escaping, and reorders', () => {
    const out = withTabs((tabs) => {
      const added = $addTab(tabs);
      expect(added.getName()).toBe('Tab 3');
      added.setName('R&D <draft>');
      expect($moveTab(added, -5)).toBe(true);
      expect($moveTab(added, -1)).toBe(false);
    });
    expect(out).toBe([
      '<div data-tabs>',
      '<details data-tab>',
      '<summary>R&amp;D &lt;draft&gt;</summary>',
      '</details>',
      ...panel(' data-tab', 'One', 'first'),
      ...panel(' data-tab', 'Two', 'second'),
      '</div>',
    ].join('\n'));
  });

  it('deletes a tab and its content, and deleting the last tab removes the block', () => {
    expect(withTabs((tabs) => {
      const [first, second] = tabs.getPanels();
      expect($deleteTab(first)?.is(second)).toBe(true);
    })).toBe(['<div data-tabs>', ...panel(' data-tab', 'Two', 'second'), '</div>'].join('\n'));

    expect(withTabs((tabs) => {
      const [first, second] = tabs.getPanels();
      $deleteTab(first);
      expect($deleteTab(second)).toBeNull();
    })).not.toContain('data-tabs');
  });
});
