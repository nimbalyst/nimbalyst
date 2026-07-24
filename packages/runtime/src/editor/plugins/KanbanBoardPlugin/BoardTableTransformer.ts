/**
 * Transformer for board tables - markdown tables that render as kanban boards
 */

import { MultilineElementTransformer } from '@lexical/markdown';
import {
  $createParagraphNode,
  $createTextNode,
  LexicalNode,
} from 'lexical';
import {
  $isBoardNode,
  $createBoardNode,
  KanbanBoardNode,
} from './KanbanBoardNode.ts';
import {
  $createBoardHeaderNode,
  $isBoardHeaderNode,
} from './BoardHeaderNode';
import {
  $createColumnNode,
  $isColumnNode,
  BoardColumnNode,
} from './BoardColumnNode';
import {
  $createColumnHeaderNode,
} from './BoardColumnHeaderNode';
import {
  $createColumnContentNode,
  $isColumnContentNode,
} from './BoardColumnContentNode';
import {
  $createCardNode,
  $isCardNode,
} from './BoardCardNode';

// Parse the metadata block for board configuration
interface BoardMetadata {
  title?: string;
  statusColumn?: string;
  viewMode?: 'table' | 'board';
  groupBy?: string;
  columns?: string[];
}

function parseMetadata(lines: string[]): BoardMetadata {
  const metadata: BoardMetadata = {
    statusColumn: 'Status', // Default
    viewMode: 'board', // Default to board view
  };

  for (const line of lines) {
    const [key, ...valueParts] = line.split(':').map(s => s.trim());
    const value = valueParts.join(':').trim();

    switch (key.toLowerCase()) {
      case 'title':
        metadata.title = value;
        break;
      case 'status-column':
      case 'status_column':
      case 'statuscolumn':
        metadata.statusColumn = value;
        break;
      case 'view':
      case 'view-mode':
      case 'viewmode':
        metadata.viewMode = value as 'table' | 'board';
        break;
      case 'group-by':
      case 'groupby':
        metadata.groupBy = value;
        break;
      case 'columns':
        metadata.columns = value.split(',').map(s => s.trim());
        break;
    }
  }

  return metadata;
}

// Very primitive table parsing
const TABLE_ROW_REG_EXP = /^(?:\|)(.+)(?:\|)\s?$/;
const TABLE_ROW_DIVIDER_REG_EXP = /^(\| ?:?-*:? ?)+\|\s?$/;

export const BOARD_TABLE_TRANSFORMER: MultilineElementTransformer = {
  dependencies: [KanbanBoardNode, BoardColumnNode],
  export: (node: LexicalNode) => {
    if (!$isBoardNode(node)) {
      return null;
    }

    const output: string[] = [];

    // Extract the board title from the header node
    let boardTitle = 'Kanban Board'; // default title
    const children = node.getChildren();
    const headerNode = children.find($isBoardHeaderNode);
    if (headerNode) {
      const titleText = headerNode.getTextContent();
      if (titleText) {
        boardTitle = titleText;
      }
    }

    // Create table from board columns and cards
    const columnData: Map<string, any[]> = new Map();
    const statusValues: string[] = [];

    // Gather columns and their cards
    for (const column of children) {
      if ($isColumnNode(column)) {
        // Get header from the column's header node
        const headerNode = column.getChildren().find(child => child.getType() === 'kanban-column-header');
        const headerText = headerNode?.getTextContent() || 'Column';
        // console.log('Board export - found column:', headerText);
        statusValues.push(headerText);

        const cards: any[] = [];
        const contentNode = column.getChildren().find($isColumnContentNode);
        if (contentNode) {
          for (const card of contentNode.getChildren()) {
            if ($isCardNode(card)) {
              const cardData = card.getData();
              cards.push({
                title: card.getTextContent() || cardData.title,
                owner: cardData.owner,
                dueDate: cardData.dueDate,
                priority: cardData.priority
              });
            }
          }
        }
        columnData.set(headerText, cards);
      }
    }

    // Start the code fence
    output.push('```board-table');

    // Add metadata
    output.push(`title: ${boardTitle}`);
    output.push('status-column: Status');
    output.push('view: board');

    // Store the list of columns
    if (statusValues.length > 0) {
      const columnsLine = `columns: ${statusValues.join(', ')}`;
      // console.log('Board export - adding columns:', columnsLine);
      output.push(columnsLine);
    }

    output.push('');

    // Create table header
    output.push('| Title | Status | Owner | Due Date | Priority |');
    output.push('| --- | --- | --- | --- | --- |');

    // Create rows from cards
    let rowIndex = 0;
    for (const [status, cards] of columnData.entries()) {
      for (const cardData of cards) {
        // If cardData is an object with metadata, extract it
        let title, owner, dueDate, priority;
        if (typeof cardData === 'object' && cardData.title) {
          title = cardData.title;
          owner = cardData.owner || '-';
          dueDate = cardData.dueDate || '-';
          priority = cardData.priority || '-';
        } else {
          // Fallback for simple string titles
          title = cardData;
          owner = '-';
          dueDate = '-';
          priority = '-';
        }
        output.push(`| ${title} | ${status} | ${owner} | ${dueDate} | ${priority} |`);
        rowIndex++;
      }
    }

    // End the code fence
    output.push('```');

    const result = output.join('\n');
    // console.log('Board export - full markdown:', result);
    return result;
  },
  regExpStart: /^```board-table$/,
  regExpEnd: {
    optional: true,
    regExp: /^```$/,
  },
  replace: (rootNode, children, startMatch, endMatch, linesInBetween) => {
    // console.log('Board import - linesInBetween:', linesInBetween);
    if (!linesInBetween || linesInBetween.length === 0) {
      return;
    }

    // Separate metadata from table content
    const metadataLines: string[] = [];
    let tableStartIndex = 0;

    for (let i = 0; i < linesInBetween.length; i++) {
      const line = linesInBetween[i].trim();

      // Skip initial empty lines
      if (line === '' && metadataLines.length === 0) {
        continue;
      }

      // Empty line after metadata marks the end of metadata
      if (line === '' && metadataLines.length > 0) {
        tableStartIndex = i + 1;
        break;
      }

      // Table starts
      if (line.startsWith('|')) {
        tableStartIndex = i;
        break;
      }

      metadataLines.push(line);
    }

    // console.log('Board import - metadata lines:', metadataLines);
    const metadata = parseMetadata(metadataLines);
    // console.log('Board import - parsed metadata:', metadata);
    const tableLines = linesInBetween.slice(tableStartIndex);

    // Parse the table
    const rows: Map<string, any[]> = new Map();
    let headers: string[] = [];
    let statusColumnIndex = 1; // Default to second column

    for (let i = 0; i < tableLines.length; i++) {
      const line = tableLines[i].trim();
      if (!line) continue;

      // Skip divider row
      if (TABLE_ROW_DIVIDER_REG_EXP.test(line)) {
        continue;
      }

      // Parse table row
      const rowMatch = line.match(TABLE_ROW_REG_EXP);
      if (!rowMatch) continue;

      const cells = rowMatch[1].split('|').map(s => s.trim());

      // First row is headers
      if (headers.length === 0) {
        headers = cells;
        // Find status column index
        statusColumnIndex = headers.findIndex(h =>
          h.toLowerCase() === metadata.statusColumn?.toLowerCase() ||
          h.toLowerCase() === 'status'
        );
        if (statusColumnIndex === -1) statusColumnIndex = 1;
        continue;
      }

      // Data rows - group by status
      const status = cells[statusColumnIndex] || 'Uncategorized';
      const title = cells[0] || 'Untitled';

      // Extract additional fields from the row
      const owner = headers.includes('Owner') ? cells[headers.indexOf('Owner')] : undefined;
      const dueDate = headers.includes('Due Date') ? cells[headers.indexOf('Due Date')] : undefined;
      const priority = headers.includes('Priority') ? cells[headers.indexOf('Priority')]?.toLowerCase() as 'low' | 'medium' | 'high' : undefined;
      const description = headers.includes('Description') ? cells[headers.indexOf('Description')] : undefined;

      if (!rows.has(status)) {
        rows.set(status, []);
      }

      // Store the full row data for richer cards
      rows.get(status)!.push({
        title,
        owner: owner !== '-' ? owner : undefined,
        dueDate: dueDate !== '-' ? dueDate : undefined,
        priority: priority && (priority as string) !== '-' ? priority : undefined,
        description: description !== '-' ? description : undefined,
        data: cells
      });
    }

    // Create the KanbanBoardNode with columns
    const boardNode = $createBoardNode();

    // Create and add the board header with title
    const boardHeader = $createBoardHeaderNode();
    const titleParagraph = $createParagraphNode();
    titleParagraph.append($createTextNode(metadata.title || 'Kanban Board'));
    boardHeader.append(titleParagraph);
    boardNode.append(boardHeader);

    // Create columns for each status
    // Use columns from metadata if available, otherwise use statuses from data
    let statuses: string[] = [];

    if (metadata.columns && metadata.columns.length > 0) {
      // Use columns from metadata
      statuses = metadata.columns;
      // console.log('Using columns from metadata:', statuses);
    } else if (rows.size > 0) {
      // Use statuses from data
      statuses = Array.from(rows.keys());
      // console.log('Using statuses from data:', statuses);
    } else {
      // Default columns if no data and no metadata
      statuses = ['To Do', 'In Progress', 'Done'];
      // console.log('Using default columns:', statuses);
    }

    for (const status of statuses) {
      const column = $createColumnNode();

      // Create header
      const header = $createColumnHeaderNode();
      const headerParagraph = $createParagraphNode();
      headerParagraph.append($createTextNode(status));
      header.append(headerParagraph);

      // Create content area
      const content = $createColumnContentNode();

      // Add cards
      const items = rows.get(status) || [];
      for (const item of items) {
        const cardData = {
          title: item.title,
          owner: item.owner,
          dueDate: item.dueDate,
          priority: item.priority,
          description: item.description
        };
        const card = $createCardNode(undefined, cardData);
        const cardParagraph = $createParagraphNode();
        cardParagraph.append($createTextNode(item.title));
        card.append(cardParagraph);
        content.append(card);
      }

      column.append(header, content);
      boardNode.append(column);
    }

    rootNode.append(boardNode);
  },
  type: 'multiline-element',
};
