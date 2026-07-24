import {
  $getSelection,
  $isRangeSelection,
  $createTextNode,
  $createParagraphNode,
  $getNearestNodeFromDOMNode,
  COMMAND_PRIORITY_EDITOR,
  createCommand,
  LexicalCommand,
  LexicalEditor,
} from 'lexical';
import {
  $createBoardNode,
  $isBoardNode,
} from './KanbanBoardNode';
import {
  $createBoardHeaderNode,
} from './BoardHeaderNode';
import { BoardConfig } from './BoardConfigDialog';
import {
  $createColumnNode,
  $isColumnNode,
} from './BoardColumnNode';
import {
  $createColumnHeaderNode,
} from './BoardColumnHeaderNode';
import {
  $createColumnContentNode,
} from './BoardColumnContentNode';
import {
  $createCardNode,
  $isCardNode,
} from './BoardCardNode';

export const INSERT_BOARD_COMMAND: LexicalCommand<void> = createCommand(
  'INSERT_BOARD_COMMAND',
);

export const INSERT_CONFIGURED_BOARD_COMMAND: LexicalCommand<{
  config: any;
}> = createCommand('INSERT_CONFIGURED_BOARD_COMMAND');

export const ADD_BOARD_COLUMN_COMMAND: LexicalCommand<string> = createCommand(
  'ADD_BOARD_COLUMN_COMMAND',
);

export const ADD_BOARD_CARD_COMMAND: LexicalCommand<{
  columnIndex: number;
  content?: string;
}> = createCommand('ADD_BOARD_CARD_COMMAND');

export const MOVE_BOARD_CARD_COMMAND: LexicalCommand<{
  cardId: string;
  fromColumnIndex: number;
  toColumnIndex: number;
  position: number;
}> = createCommand('MOVE_BOARD_CARD_COMMAND');

export const UPDATE_BOARD_COLUMN_TITLE_COMMAND: LexicalCommand<{
  columnIndex: number;
  title: string;
}> = createCommand('UPDATE_BOARD_COLUMN_TITLE_COMMAND');

export const DELETE_BOARD_CARD_COMMAND: LexicalCommand<{
  cardId: string;
}> = createCommand('DELETE_BOARD_CARD_COMMAND');

// Command handlers
export function registerKanbanCommands(editor: LexicalEditor): () => void {
  const removeInsertBoardCommand = editor.registerCommand(
    INSERT_BOARD_COMMAND,
    () => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) {
        const kanbanBoard = $createBoardNode();

        // Create header node with title
        const headerNode = $createBoardHeaderNode();
        const titleParagraph = $createParagraphNode();
        titleParagraph.append($createTextNode('Kanban Board'));
        headerNode.append(titleParagraph);
        kanbanBoard.append(headerNode);

        // Create columns with header and content nodes
        const createColumn = (title: string) => {
          const column = $createColumnNode();

          // Create header with title text
          const header = $createColumnHeaderNode();
          const headerParagraph = $createParagraphNode();
          headerParagraph.append($createTextNode(title));
          header.append(headerParagraph);

          // Create content area for cards
          const content = $createColumnContentNode();

          column.append(header, content);
          return { column, content };
        };

        const { column: todoColumn, content: todoContent } = createColumn('To Do');
        const { column: inProgressColumn } = createColumn('In Progress');
        const { column: doneColumn } = createColumn('Done');

        // Add sample cards to demonstrate functionality
        const sampleCard1 = $createCardNode();
        const sampleParagraph1 = $createParagraphNode();
        sampleParagraph1.append($createTextNode('Sample task 1'));
        sampleCard1.append(sampleParagraph1);

        const sampleCard2 = $createCardNode();
        const sampleParagraph2 = $createParagraphNode();
        sampleParagraph2.append($createTextNode('Sample task 2'));
        sampleCard2.append(sampleParagraph2);

        todoContent.append(sampleCard1, sampleCard2);
        kanbanBoard.append(todoColumn, inProgressColumn, doneColumn);
        selection.insertNodes([kanbanBoard]);
      }
      return true;
    },
    COMMAND_PRIORITY_EDITOR,
  );

  const removeInsertConfiguredBoardCommand = editor.registerCommand(
    INSERT_CONFIGURED_BOARD_COMMAND,
    ({ config }: { config: BoardConfig }) => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) {
        const kanbanBoard = $createBoardNode(config);

        // Create header node with title
        const headerNode = $createBoardHeaderNode();
        const titleParagraph = $createParagraphNode();
        titleParagraph.append($createTextNode('Kanban Board'));
        headerNode.append(titleParagraph);
        kanbanBoard.append(headerNode);

        // Board will be populated by the sync service once it starts
        // Just insert the configured board node for now
        selection.insertNodes([kanbanBoard]);

        // Dispatch event to notify the plugin to start sync service
        setTimeout(() => {
          window.dispatchEvent(new CustomEvent('board-created', {
            detail: { nodeKey: kanbanBoard.getKey(), config }
          }));
        }, 0);
      }
      return true;
    },
    COMMAND_PRIORITY_EDITOR,
  );

  const removeAddColumnCommand = editor.registerCommand(
    ADD_BOARD_COLUMN_COMMAND,
    (title: string) => {
      editor.update(() => {
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          const nodes = selection.getNodes();
          for (const node of nodes) {
            const kanbanBoard = node.getTopLevelElement();
            if ($isBoardNode(kanbanBoard)) {
              const newColumn = $createColumnNode();
              // TODO: Add method to set column title if needed
              // For now, the column will use default title
              kanbanBoard.append(newColumn);
              break;
            }
          }
        }
      });
      return true;
    },
    COMMAND_PRIORITY_EDITOR,
  );

  const removeAddCardCommand = editor.registerCommand(
    ADD_BOARD_CARD_COMMAND,
    ({columnIndex, content}) => {
      editor.update(() => {
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          const nodes = selection.getNodes();
          for (const node of nodes) {
            const kanbanBoard = node.getTopLevelElement();
            if ($isBoardNode(kanbanBoard)) {
              const columns = kanbanBoard.getChildren();
              if (columnIndex < columns.length) {
                const targetColumn = columns[columnIndex];
                if ($isColumnNode(targetColumn)) {
                  const card = $createCardNode();
                  const paragraph = $createParagraphNode();
                  if (content) {
                    paragraph.append($createTextNode(content));
                  }
                  card.append(paragraph);
                  targetColumn.append(card);
                }
              }
              break;
            }
          }
        }
      });
      return true;
    },
    COMMAND_PRIORITY_EDITOR,
  );

  const removeUpdateColumnTitleCommand = editor.registerCommand(
    UPDATE_BOARD_COLUMN_TITLE_COMMAND,
    ({columnIndex, title}) => {
      editor.update(() => {
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          const nodes = selection.getNodes();
          for (const node of nodes) {
            const kanbanBoard = node.getTopLevelElement();
            if ($isBoardNode(kanbanBoard)) {
              const columns = kanbanBoard.getChildren();
              if (columnIndex < columns.length) {
                const targetColumn = columns[columnIndex];
                if ($isColumnNode(targetColumn)) {
                  // TODO: Add method to set column title if needed
                  // targetColumn.setTitle(title);
                }
              }
              break;
            }
          }
        }
      });
      return true;
    },
    COMMAND_PRIORITY_EDITOR,
  );

  const removeDeleteCardCommand = editor.registerCommand(
    DELETE_BOARD_CARD_COMMAND,
    ({cardId}) => {
      editor.update(() => {
        const root = editor.getEditorState()._nodeMap;
        for (const [, node] of root) {
          if ($isCardNode(node) && node.getId() === cardId) {
            node.remove();
            break;
          }
        }
      });
      return true;
    },
    COMMAND_PRIORITY_EDITOR,
  );

  const removeMoveCardCommand = editor.registerCommand(
    MOVE_BOARD_CARD_COMMAND,
    ({cardId, fromColumnIndex, toColumnIndex, position}) => {
      editor.update(() => {
        // Find the DOM element with the card ID
        const cardElement = document.querySelector(`[data-card-id="${cardId}"]`);
        if (!cardElement) {
          console.warn('Could not find card DOM element for move operation', { cardId });
          return;
        }

        // Use Lexical's method to get the node from DOM
        const cardNode = $getNearestNodeFromDOMNode(cardElement);
        if (!$isCardNode(cardNode)) {
          console.warn('DOM element does not correspond to a valid BoardCardNode', { cardId });
          return;
        }

        // Find the target column DOM element
        const boardElement = cardElement.closest('.kanban-board');
        if (!boardElement) {
          console.warn('Could not find kanban board element');
          return;
        }

        const columnElements = Array.from(boardElement.querySelectorAll('.kanban-column'));
        const targetColumnElement = columnElements[toColumnIndex];
        if (!targetColumnElement) {
          console.warn('Could not find target column element', { toColumnIndex });
          return;
        }

        // Get the target column node
        const targetColumnNode = $getNearestNodeFromDOMNode(targetColumnElement);
        if (!$isColumnNode(targetColumnNode)) {
          console.warn('Target column DOM element does not correspond to a valid BoardColumnNode');
          return;
        }

        // Extract the text content safely
        const cardText = cardNode.getTextContent() || 'Moved card';

        // Remove the original card
        cardNode.remove();

        // Create a new card with the same content
        const newCard = $createCardNode(cardId);
        const paragraph = $createParagraphNode();
        paragraph.append($createTextNode(cardText));
        newCard.append(paragraph);

        // Append the new card to the target column
        targetColumnNode.append(newCard);
      });
      return true;
    },
    COMMAND_PRIORITY_EDITOR,
  );

  return () => {
    removeInsertBoardCommand();
    removeInsertConfiguredBoardCommand();
    removeAddColumnCommand();
    removeAddCardCommand();
    removeUpdateColumnTitleCommand();
    removeDeleteCardCommand();
    removeMoveCardCommand();
  };
}
