// @vitest-environment node
/**
 * The wiki blocks' block-menu items, run against a headless editor: which
 * items a block offers in its current state, and that running one rewrites
 * only what it owns.
 */

import { describe, expect, it, vi } from 'vitest';
import { createHeadlessEditor } from '@lexical/headless';
import { $createParagraphNode, $createTextNode, $getRoot, ParagraphNode, TextNode, type LexicalNode } from 'lexical';

import { draggableBlockMenuRegistry } from '../DraggableBlockMenuRegistry';
import { registerBlockActions } from '../blockActions';
import { $createChartNode, $isChartNode, ChartNode } from '../../ChartPlugin/ChartNodeCore';
import { $createLayoutContainerNode, $isLayoutContainerNode, LayoutContainerNode } from '../../LayoutPlugin/LayoutContainerNode';
import { $createLayoutItemNode, LayoutItemNode } from '../../LayoutPlugin/LayoutItemNode';
import '../../ChartPlugin/chartBlockMenu';
import '../../LayoutPlugin/layoutBlockMenu';

const editor = createHeadlessEditor({ nodes: [ChartNode, LayoutContainerNode, LayoutItemNode, ParagraphNode, TextNode], onError: (error) => { throw error; } });

function build(create: () => LexicalNode): string {
  let key = '';
  editor.update(() => {
    const node = create();
    $getRoot().clear().append(node);
    key = node.getKey();
  }, { discrete: true });
  return key;
}

const menu = (_key: string) => editor.getEditorState().read(() => draggableBlockMenuRegistry.getMenuItemsForNode($getRoot().getFirstChild()!, editor));
const labels = (key: string) => menu(key).map((item) => item.label);
const run = (key: string, label: string) => {
  const item = menu(key).find((candidate) => candidate.label === label)!;
  editor.getEditorState().read(() => item.command(editor, $getRoot().getFirstChild()!));
  editor.update(() => {}, { discrete: true });
};
const read = <T>(fn: (node: LexicalNode) => T) => editor.getEditorState().read(() => fn($getRoot().getFirstChild()!));

describe('chart block menu', () => {
  const SOURCE = 'type: bar\ntitle: Weekly\nx: week\ny: [desktop, web]\ndata: |\n  week,desktop,web\n  W1,1,2';

  it('offers the other types (no pie for several series), and actions only while the block offers them', async () => {
    const key = build(() => $createChartNode({ source: SOURCE }));
    expect(labels(key)).toEqual(['Change to line chart', 'Change to area chart', 'Change to scatter chart']);
    const unregister = registerBlockActions(editor, key, { available: () => ['edit-title'], run: () => {} });
    expect(labels(key)).toContain('Edit title');
    expect(labels(key)).not.toContain('Edit data and settings');
    unregister();
    run(key, 'Change to line chart');
    // The rewrite loads its YAML parser on use.
    await vi.waitFor(() => expect(read((node) => ($isChartNode(node) ? node.getSource() : ''))).toBe(SOURCE.replace('type: bar', 'type: line')));
  });
});

describe('columns block menu', () => {
  it('removing the last column moves its content into the column before it', () => {
    const key = build(() => $createLayoutContainerNode('2fr 1fr 1fr').append(
      ...['left', 'middle', 'right'].map((text) => $createLayoutItemNode().append($createParagraphNode().append($createTextNode(text))))));
    expect(labels(key)).toEqual(['Add column', 'Remove last column', 'Make columns equal width']);
    run(key, 'Remove last column');
    expect(read((node) => ($isLayoutContainerNode(node) ? [node.getTemplateColumns(), node.getChildren().map((item) => item.getTextContent())] : null)))
      .toEqual(['2fr 1fr', ['left', 'middle\n\nright']]);
    run(key, 'Make columns equal width');
    expect(read((node) => ($isLayoutContainerNode(node) ? node.getTemplateColumns() : null))).toBe('1fr 1fr');
  });
});
