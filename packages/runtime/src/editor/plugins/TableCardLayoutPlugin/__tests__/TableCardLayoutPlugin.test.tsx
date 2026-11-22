import { act, render } from '@testing-library/react';
import { LexicalExtensionComposer } from '@lexical/react/LexicalExtensionComposer';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { TablePlugin } from '@lexical/react/LexicalTablePlugin';
import {
  $createTableNodeWithDimensions,
  $isTableNode,
  TableCellNode,
  TableNode,
  TableRowNode,
} from '@lexical/table';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  defineExtension,
  type ElementNode,
  type LexicalEditor,
} from 'lexical';
import { describe, expect, it } from 'vitest';
import TableCardLayoutPlugin, { isTableShowingCards } from '..';

function $cell(row: number, col: number): ElementNode {
  const table = $getRoot().getChildren().find($isTableNode)!;
  return (table.getChildAtIndex(row) as ElementNode).getChildAtIndex(col) as ElementNode;
}

function $setCellText(row: number, col: number, text: string): void {
  const cell = $cell(row, col);
  cell.clear();
  cell.append($createParagraphNode().append($createTextNode(text)));
}

const extension = defineExtension({
  name: '@nimbalyst/test/table-card-layout',
  namespace: 'NimbalystTableCardLayoutTest',
  nodes: [TableNode, TableRowNode, TableCellNode],
  onError: (error: Error) => {
    throw error;
  },
  theme: { table: 'nim-table', tableScrollableWrapper: 'nim-table-scrollable-wrapper' },
  $initialEditorState: () => {
    $getRoot().append(
      $createTableNodeWithDimensions(3, 2, { rows: true, columns: false }),
      $createParagraphNode()
    );
    $setCellText(0, 0, 'Track');
    $setCellText(0, 1, 'Stage');
    $setCellText(1, 0, 'Sync');
    $setCellText(1, 1, 'Beta');
  },
});

function CaptureEditor({ onReady }: { onReady: (editor: LexicalEditor) => void }): null {
  const [editor] = useLexicalComposerContext();
  onReady(editor);
  return null;
}

describe('TableCardLayoutPlugin', () => {
  it('labels body cells from the header row, follows header edits, and marks the table being edited', async () => {
    let editor!: LexicalEditor;
    const view = render(
      <LexicalExtensionComposer extension={extension} contentEditable={null}>
        <RichTextPlugin contentEditable={<ContentEditable />} ErrorBoundary={LexicalErrorBoundary} />
        <TablePlugin hasCellMerge={false} hasCellBackgroundColor={false} hasHorizontalScroll={true} />
        <TableCardLayoutPlugin />
        <CaptureEditor onReady={(value) => (editor = value)} />
      </LexicalExtensionComposer>
    );
    await act(async () => {});

    const table = view.container.querySelector('table')!;
    const bodyCells = () => Array.from(table.querySelectorAll('tr:nth-of-type(2) > *'));
    expect(table.hasAttribute('data-nim-table-cards')).toBe(true);
    expect(bodyCells().map((cell) => cell.getAttribute('data-label'))).toEqual(['Track', 'Stage']);

    await act(async () => {
      editor.update(() => $setCellText(0, 1, 'Progress'), { discrete: true });
    });
    expect(bodyCells().map((cell) => cell.getAttribute('data-label'))).toEqual(['Track', 'Progress']);

    expect(table.hasAttribute('data-nim-table-editing')).toBe(false);
    await act(async () => {
      editor.update(() => $cell(1, 1).selectEnd(), { discrete: true });
    });
    expect(table.hasAttribute('data-nim-table-editing')).toBe(true);
    // jsdom has no container queries; an inline display stands in for the card CSS.
    table.style.display = 'block';
    expect(isTableShowingCards(table)).toBe(false);
    await act(async () => {
      editor.update(() => $getRoot().getLastChildOrThrow().selectEnd(), { discrete: true });
    });
    expect(table.hasAttribute('data-nim-table-editing')).toBe(false);
    expect(isTableShowingCards(table)).toBe(true);

    view.unmount();
  });
});
