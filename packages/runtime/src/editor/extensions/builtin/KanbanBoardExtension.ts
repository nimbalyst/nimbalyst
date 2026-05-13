/**
 * Headless half of the Kanban Board plugin. Owns all board-related node
 * registrations, the board markdown transformer, the
 * `registerKanbanCommands` / `registerBoardTransformCommands` calls, and
 * the cross-column drag/drop visual feedback + drop handling.
 *
 * The React `KanbanBoardPlugin` component is still mounted in the editor's
 * Lexical context for dialog state (config dialog, card edit dialog) and
 * for the `board-*` `CustomEvent` listeners that mutate React state.
 */

import {
  COMMAND_PRIORITY_HIGH,
  COMMAND_PRIORITY_LOW,
  DRAGOVER_COMMAND,
  DROP_COMMAND,
  $createParagraphNode,
  $createTextNode,
  $getNearestNodeFromDOMNode,
  defineExtension,
} from 'lexical';
import { mergeRegister } from '@lexical/utils';

import { BoardCardNode, $createCardNode, $isCardNode } from '../../plugins/KanbanBoardPlugin/BoardCardNode';
import { BoardColumnContentNode, $isColumnContentNode } from '../../plugins/KanbanBoardPlugin/BoardColumnContentNode';
import { BoardColumnHeaderNode } from '../../plugins/KanbanBoardPlugin/BoardColumnHeaderNode';
import { BoardColumnNode } from '../../plugins/KanbanBoardPlugin/BoardColumnNode';
import { BoardHeaderNode } from '../../plugins/KanbanBoardPlugin/BoardHeaderNode';
import { KanbanBoardNode, $isBoardNode } from '../../plugins/KanbanBoardPlugin/KanbanBoardNode';
import { BOARD_TABLE_TRANSFORMER } from '../../plugins/KanbanBoardPlugin/BoardTableTransformer';
import { registerKanbanCommands } from '../../plugins/KanbanBoardPlugin/BoardCommands';
import { registerBoardTransformCommands } from '../../plugins/KanbanBoardPlugin/BoardTransformCommands';
import { setExtensionContributions } from '../extensionContributionsStore';

const NAME = '@nimbalyst/editor/kanban-board';

function resetColumnVisualFeedback(): void {
  const allColumnContents = document.querySelectorAll('.kanban-column-content');
  allColumnContents.forEach((content) => {
    const element = content as HTMLElement;
    element.style.backgroundColor = '';
    element.style.borderColor = '';
    element.style.borderStyle = '';
  });
}

export const KanbanBoardExtension = defineExtension({
  name: NAME,
  nodes: [
    KanbanBoardNode,
    BoardHeaderNode,
    BoardColumnNode,
    BoardColumnHeaderNode,
    BoardColumnContentNode,
    BoardCardNode,
  ],
  register: (editor) => {
    const unregisterCommands = registerKanbanCommands(editor);
    const unregisterTransformCommands = registerBoardTransformCommands();

    const handleDragEnd = () => resetColumnVisualFeedback();
    const handleDragLeave = (e: Event) => {
      const target = e.target as HTMLElement;
      if (target.classList.contains('kanban-board')) {
        resetColumnVisualFeedback();
      }
    };

    document.addEventListener('dragend', handleDragEnd);
    document.addEventListener('dragleave', handleDragLeave);

    const unregisterDragDrop = mergeRegister(
      editor.registerCommand(
        DRAGOVER_COMMAND,
        (event: DragEvent) => {
          const target = event.target as HTMLElement;
          const columnContent = target.closest('.kanban-column-content');
          resetColumnVisualFeedback();
          if (
            columnContent &&
            event.dataTransfer?.types.includes('application/x-kanban-card')
          ) {
            event.preventDefault();
            const htmlColumnContent = columnContent as HTMLElement;
            htmlColumnContent.style.backgroundColor = '#f0f8ff';
            htmlColumnContent.style.borderColor = '#4a90e2';
            htmlColumnContent.style.borderStyle = 'dashed';
            return true;
          }
          return false;
        },
        COMMAND_PRIORITY_LOW,
      ),
      editor.registerCommand(
        DROP_COMMAND,
        (event: DragEvent) => {
          resetColumnVisualFeedback();
          const target = event.target as HTMLElement;
          const columnContent = target.closest('.kanban-column-content');
          const column = target.closest('.kanban-column');
          if (
            !columnContent ||
            !column ||
            !event.dataTransfer?.types.includes('application/x-kanban-card')
          ) {
            return false;
          }
          const cardId = event.dataTransfer.getData('application/x-kanban-card');
          if (!cardId) return false;

          const targetColumnContentNode = $getNearestNodeFromDOMNode(columnContent);
          if (!$isColumnContentNode(targetColumnContentNode)) return false;

          const cardElement = document.querySelector(`[data-card-id="${cardId}"]`);
          if (!cardElement) return false;

          const sourceCardNode = $getNearestNodeFromDOMNode(cardElement);
          if (!$isCardNode(sourceCardNode)) return false;

          const sourceColumn = cardElement.closest('.kanban-column');
          if (sourceColumn === column) return true;

          editor.update(() => {
            const cardText = sourceCardNode.getTextContent() || 'Moved card';
            const cardData = sourceCardNode.getData();
            sourceCardNode.remove();
            const newCard = $createCardNode(cardId, cardData);
            const paragraph = $createParagraphNode();
            paragraph.append($createTextNode(cardText));
            newCard.append(paragraph);
            targetColumnContentNode.append(newCard);
          });

          // Notify any sync service listening for cross-column card moves.
          const boardElement = target.closest('.kanban-board');
          if (boardElement) {
            const boardNode = $getNearestNodeFromDOMNode(boardElement);
            if ($isBoardNode(boardNode)) {
              const columns = Array.from(
                boardElement.querySelectorAll('.kanban-column'),
              );
              const fromColumnIndex = columns.findIndex((col) =>
                col.contains(sourceColumn),
              );
              const toColumnIndex = columns.findIndex((col) => col === column);
              window.dispatchEvent(
                new CustomEvent('kanban-card-moved', {
                  detail: { cardId, fromColumnIndex, toColumnIndex },
                }),
              );
            }
          }
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
    );

    return () => {
      unregisterCommands();
      unregisterTransformCommands();
      unregisterDragDrop();
      document.removeEventListener('dragend', handleDragEnd);
      document.removeEventListener('dragleave', handleDragLeave);
    };
  },
});

setExtensionContributions(NAME, {
  markdownTransformers: [BOARD_TABLE_TRANSFORMER],
});
