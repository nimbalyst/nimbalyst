import { LexicalEditor, LexicalNode, $getNodeByKey, $isElementNode } from 'lexical';
import {
    $createTableNode,
    $createTableRowNode,
    $createTableCellNode,
    TableNode,
    $isTableNode,
    $isTableRowNode,
    $isTableCellNode,
    TableCellHeaderStates
} from '@lexical/table';
import { $createParagraphNode, $createTextNode} from 'lexical';
import {$isListItemNode, $isListNode} from '@lexical/list';
import { KanbanBoardNode, $isBoardNode, $createBoardNode } from './KanbanBoardNode.ts';
import { $createBoardHeaderNode, $isBoardHeaderNode } from './BoardHeaderNode';
import { $isColumnNode, $createColumnNode } from './BoardColumnNode';
import { $isColumnHeaderNode, $createColumnHeaderNode } from './BoardColumnHeaderNode';
import { $isColumnContentNode, $createColumnContentNode } from './BoardColumnContentNode';
import { $isCardNode, $createCardNode } from './BoardCardNode';
import { draggableBlockMenuRegistry } from '../DraggableBlockPlugin/DraggableBlockMenuRegistry';
import { CardData } from './BoardCardNode';

/**
 * Transform a KanbanBoardNode into a TableNode
 * Each card becomes a row in the table
 * Fields (Title, Status, Owner, Due Date, Priority, Description) become columns
 */
export function $transformBoardToTable(boardNode: KanbanBoardNode): TableNode | null {
  if (!$isBoardNode(boardNode)) {
    return null;
  }

  const tableNode = $createTableNode();
  // Get only column nodes, skip the header node
  const columns = boardNode.getChildren().filter($isColumnNode);

  if (columns.length === 0) {
    return null;
  }

  // Collect all cards from all columns
  const allCards: Array<{card: any, status: string}> = [];

  columns.forEach(column => {
    const header = column.getChildren().find($isColumnHeaderNode);
    const statusName = header ? header.getTextContent() : 'Unknown';
    const content = column.getChildren().find($isColumnContentNode);
    const cards = content ? content.getChildren().filter($isCardNode) : [];

    cards.forEach(card => {
      allCards.push({ card, status: statusName });
    });
  });

  // Create header row with field names
  const headerRow = $createTableRowNode();
  const headers = ['Title', 'Status', 'Owner', 'Due Date', 'Priority', 'Description'];

  headers.forEach(headerText => {
    const headerCell = $createTableCellNode(TableCellHeaderStates.COLUMN); // isHeader = true
    const paragraph = $createParagraphNode();
    paragraph.append($createTextNode(headerText));
    headerCell.append(paragraph);
    headerRow.append(headerCell);
  });
  tableNode.append(headerRow);

  // Create a row for each card
  allCards.forEach(({ card, status }) => {
    const row = $createTableRowNode();
    const cardData = card.getData();
    const cardText = card.getTextContent();

    // Title cell
    const titleCell = $createTableCellNode(TableCellHeaderStates.NO_STATUS);
    const titleParagraph = $createParagraphNode();
    titleParagraph.append($createTextNode(cardData.title || cardText || ''));
    titleCell.append(titleParagraph);
    row.append(titleCell);

    // Status cell
    const statusCell = $createTableCellNode(TableCellHeaderStates.NO_STATUS);
    const statusParagraph = $createParagraphNode();
    statusParagraph.append($createTextNode(status));
    statusCell.append(statusParagraph);
    row.append(statusCell);

    // Owner cell
    const ownerCell = $createTableCellNode(TableCellHeaderStates.NO_STATUS);
    const ownerParagraph = $createParagraphNode();
    ownerParagraph.append($createTextNode(cardData.owner || ''));
    ownerCell.append(ownerParagraph);
    row.append(ownerCell);

    // Due Date cell
    const dueDateCell = $createTableCellNode(TableCellHeaderStates.NO_STATUS);
    const dueDateParagraph = $createParagraphNode();
    dueDateParagraph.append($createTextNode(cardData.dueDate || ''));
    dueDateCell.append(dueDateParagraph);
    row.append(dueDateCell);

    // Priority cell
    const priorityCell = $createTableCellNode(TableCellHeaderStates.NO_STATUS);
    const priorityParagraph = $createParagraphNode();
    priorityParagraph.append($createTextNode(cardData.priority || ''));
    priorityCell.append(priorityParagraph);
    row.append(priorityCell);

    // Description cell
    const descCell = $createTableCellNode(TableCellHeaderStates.NO_STATUS);
    const descParagraph = $createParagraphNode();
    descParagraph.append($createTextNode(cardData.description || ''));
    descCell.append(descParagraph);
    row.append(descCell);

    tableNode.append(row);
  });

  return tableNode;
}

/**
 * Transform a TableNode into a KanbanBoardNode
 * Expects table with headers: Title, Status, Owner, Due Date, Priority, Description
 * Groups rows by Status column into board columns
 */
export function $transformTableToBoard(tableNode: TableNode): KanbanBoardNode | null {
  if (!$isTableNode(tableNode)) {
    return null;
  }

  const rows = tableNode.getChildren();
  if (rows.length < 2) {
    // Need at least header row and one data row
    return null;
  }

  // Get header row to find column indices
  const headerRow = rows[0];
  if (!$isTableRowNode(headerRow)) {
    return null;
  }

  const headerCells = headerRow.getChildren();
  const columnIndices: { [key: string]: number } = {};

  // Find indices for each field
  headerCells.forEach((cell, index) => {
    if ($isTableCellNode(cell)) {
      const headerText = cell.getTextContent().toLowerCase().trim();
      if (headerText === 'title') columnIndices.title = index;
      else if (headerText === 'status') columnIndices.status = index;
      else if (headerText === 'owner') columnIndices.owner = index;
      else if (headerText === 'due date') columnIndices.dueDate = index;
      else if (headerText === 'priority') columnIndices.priority = index;
      else if (headerText === 'description') columnIndices.description = index;
    }
  });

  // We need at least title and status columns
  if (columnIndices.title === undefined || columnIndices.status === undefined) {
    return null;
  }

  // Group rows by status
  const cardsByStatus: Map<string, CardData[]> = new Map();

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!$isTableRowNode(row)) continue;

    const cells = row.getChildren();
    const status = cells[columnIndices.status]?.getTextContent() || 'To Do';
    const cardData: CardData = {
      title: cells[columnIndices.title]?.getTextContent() || '',
      owner: columnIndices.owner !== undefined ? cells[columnIndices.owner]?.getTextContent() || '' : '',
      dueDate: columnIndices.dueDate !== undefined ? cells[columnIndices.dueDate]?.getTextContent() || '' : '',
      priority: columnIndices.priority !== undefined
        ? (cells[columnIndices.priority]?.getTextContent() || '') as 'low' | 'medium' | 'high' | undefined
        : undefined,
      description: columnIndices.description !== undefined ? cells[columnIndices.description]?.getTextContent() || '' : '',
    };

    if (!cardsByStatus.has(status)) {
      cardsByStatus.set(status, []);
    }
    cardsByStatus.get(status)!.push(cardData);
  }

  // Create board with columns
  const boardNode = $createBoardNode();

  // Create header node with title
  const headerNode = $createBoardHeaderNode();
  const titleParagraph = $createParagraphNode();
  titleParagraph.append($createTextNode('Project Tasks'));
  headerNode.append(titleParagraph);
  boardNode.append(headerNode);

  // Create a column for each status
  cardsByStatus.forEach((cards, status) => {
    const column = $createColumnNode();

    // Create header
    const header = $createColumnHeaderNode();
    const headerParagraph = $createParagraphNode();
    headerParagraph.append($createTextNode(status));
    header.append(headerParagraph);

    // Create content area with cards
    const content = $createColumnContentNode();

    cards.forEach(cardData => {
      const card = $createCardNode(undefined, cardData);
      const paragraph = $createParagraphNode();
      paragraph.append($createTextNode(cardData.title || 'Untitled'));
      card.append(paragraph);
      content.append(card);
    });

    column.append(header, content);
    boardNode.append(column);
  });

  return boardNode;
}

/**
 * Transform a List into a KanbanBoardNode
 * Each list item becomes a card in a single "To Do" column
 */
export function $transformListToBoard(listNode: LexicalNode): KanbanBoardNode | null {
  if (!$isListNode(listNode)) {
    return null;
  }

  const boardNode = $createBoardNode();

  // Create header node with title
  const headerNode = $createBoardHeaderNode();
  const titleParagraph = $createParagraphNode();
  titleParagraph.append($createTextNode('Task List'));
  headerNode.append(titleParagraph);
  boardNode.append(headerNode);

  // Create a single "To Do" column
  const column = $createColumnNode();

  // Create header
  const header = $createColumnHeaderNode();
  const headerParagraph = $createParagraphNode();
  headerParagraph.append($createTextNode('To Do'));
  header.append(headerParagraph);

  // Create content area with cards from list items
  const content = $createColumnContentNode();

  const listItems = listNode.getChildren();
  listItems.forEach(item => {
    if ($isListItemNode(item)) {
      const cardText = item.getTextContent();
      const cardData: CardData = {
        title: cardText,
      };

      const card = $createCardNode(undefined, cardData);
      const paragraph = $createParagraphNode();
      paragraph.append($createTextNode(cardText || 'New Card'));
      card.append(paragraph);
      content.append(card);
    }
  });

  column.append(header, content);
  boardNode.append(column);

  return boardNode;
}

/**
 * Register the transform commands with the DraggableBlockPlugin
 */
export function registerBoardTransformCommands(): () => void {
  // The Kanban board block-menu transforms are commented out — the Kanban board
  // feature was never finished. Re-enable these when the board work resumes.
  // // Register Board to Table transform
  // const unregisterBoardToTable = draggableBlockMenuRegistry.registerMenuItem({
  //   id: 'transform-board-to-table',
  //   label: 'Convert to Table',
  //   icon: 'table_chart',
  //   nodeTypes: ['kanban-board'],
  //   order: 100,
  //   command: (editor: LexicalEditor, node: LexicalNode) => {
  //     editor.update(() => {
  //       if ($isBoardNode(node)) {
  //         const tableNode = $transformBoardToTable(node);
  //         if (tableNode) {
  //           node.replace(tableNode);
  //           // if the selection was in the board, the replace causes errors
  //           tableNode.selectStart();
  //         }
  //       }
  //     });
  //   }
  // });

  // // Register Table to Board transform
  // const unregisterTableToBoard = draggableBlockMenuRegistry.registerMenuItem({
  //   id: 'transform-table-to-board',
  //   label: 'Convert to Kanban Board',
  //   icon: 'view_kanban',
  //   nodeTypes: ['table'],
  //   order: 100,
  //   command: (editor: LexicalEditor, node: LexicalNode) => {
  //     editor.update(() => {
  //       if ($isTableNode(node)) {
  //         const boardNode = $transformTableToBoard(node);
  //         if (boardNode) {
  //           node.replace(boardNode);
  //           // if the selection was in the table, the replace causes errors
  //           boardNode.selectStart();
  //         }
  //       }
  //     });
  //   }
  // });

  // // Register List to Board transform
  // const unregisterListToBoard = draggableBlockMenuRegistry.registerMenuItem({
  //   id: 'transform-list-to-board',
  //   label: 'Convert to Kanban Board',
  //   icon: 'view_kanban',
  //   nodeTypes: ['list'],
  //   order: 100,
  //   command: (editor: LexicalEditor, node: LexicalNode) => {
  //     editor.update(() => {
  //       if ($isListNode(node)) {
  //         const boardNode = $transformListToBoard(node);
  //         if (boardNode) {
  //           node.replace(boardNode);
  //           // if the selection was in the list, the replace causes errors
  //           boardNode.selectStart();
  //         }
  //       }
  //     });
  //   }
  // });

  return () => {
    // unregisterBoardToTable();
    // unregisterTableToBoard();
    // unregisterListToBoard();
  };
}
