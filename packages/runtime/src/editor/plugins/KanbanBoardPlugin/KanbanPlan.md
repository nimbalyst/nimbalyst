# Kanban Board Implementation Plan for Lexical

## Overview

This document outlines a complete implementation plan for building a Kanban board using Lexical's text editor framework. The implementation leverages Lexical's `getDOMSlot` API to create a sophisticated board layout while maintaining full text editing capabilities within cards.

## Architecture

### Node Hierarchy
```
RootNode
└── KanbanBoardNode (ElementNode)
    └── ColumnNode (ElementNode) 
        └── CardNode (ElementNode)
            └── ParagraphNode, TextNode, etc. (regular Lexical content)
```

### Core Components

1. **KanbanBoardNode**: Main container managing the overall board layout
2. **ColumnNode**: Individual columns (e.g., "To Do", "In Progress", "Done")
3. **CardNode**: Individual cards containing editable content
4. **Commands**: For moving cards, creating columns, etc.
5. **Plugin**: React integration and toolbar controls

## Implementation Steps

### Phase 1: Core Node Implementation

#### Step 1.1: Create KanbanBoardNode

**File**: `src/nodes/KanbanBoardNode.ts`

```typescript
import {
  $applyNodeReplacement,
  ElementNode,
  LexicalNode,
  NodeKey,
  SerializedElementNode,
  Spread,
} from 'lexical';
import {ElementDOMSlot} from 'lexical';

export type SerializedKanbanBoardNode = Spread<
  {
    type: 'kanban-board';
    version: 1;
  },
  SerializedElementNode
>;

export class KanbanBoardNode extends ElementNode {
  static getType(): string {
    return 'kanban-board';
  }

  static clone(node: KanbanBoardNode): KanbanBoardNode {
    return new KanbanBoardNode(node.__key);
  }

  createDOM(): HTMLElement {
    const element = document.createElement('div');
    element.className = 'kanban-board';
    element.style.cssText = `
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: 1rem;
      padding: 1rem;
      min-height: 400px;
      background: #f5f5f5;
      border-radius: 8px;
    `;
    return element;
  }

  updateDOM(): false {
    return false;
  }

  getDOMSlot(element: HTMLElement): ElementDOMSlot {
    return super.getDOMSlot(element);
  }

  static importJSON(serializedNode: SerializedKanbanBoardNode): KanbanBoardNode {
    return $createKanbanBoardNode();
  }

  exportJSON(): SerializedKanbanBoardNode {
    return {
      ...super.exportJSON(),
      type: 'kanban-board',
      version: 1,
    };
  }

  canBeEmpty(): false {
    return false;
  }

  isShadowRoot(): true {
    return true;
  }
}

export function $createKanbanBoardNode(): KanbanBoardNode {
  return $applyNodeReplacement(new KanbanBoardNode());
}

export function $isKanbanBoardNode(
  node: LexicalNode | null | undefined,
): node is KanbanBoardNode {
  return node instanceof KanbanBoardNode;
}
```

#### Step 1.2: Create ColumnNode

**File**: `src/nodes/ColumnNode.ts`

```typescript
import {
  $applyNodeReplacement,
  ElementNode,
  LexicalNode,
  NodeKey,
  SerializedElementNode,
  Spread,
} from 'lexical';
import {ElementDOMSlot} from 'lexical';

export type SerializedColumnNode = Spread<
  {
    type: 'kanban-column';
    title: string;
    version: 1;
  },
  SerializedElementNode
>;

export class ColumnNode extends ElementNode {
  __title: string;

  constructor(title: string, key?: NodeKey) {
    super(key);
    this.__title = title;
  }

  static getType(): string {
    return 'kanban-column';
  }

  static clone(node: ColumnNode): ColumnNode {
    return new ColumnNode(node.__title, node.__key);
  }

  getTitle(): string {
    return this.__title;
  }

  setTitle(title: string): void {
    const writable = this.getWritable();
    writable.__title = title;
  }

  createDOM(): HTMLElement {
    const element = document.createElement('div');
    element.className = 'kanban-column';
    
    const header = document.createElement('div');
    header.className = 'kanban-column-header';
    header.textContent = this.__title;
    header.style.cssText = `
      font-weight: bold;
      padding: 0.5rem;
      background: #e0e0e0;
      border-radius: 4px 4px 0 0;
      margin-bottom: 0.5rem;
    `;

    const cardContainer = document.createElement('div');
    cardContainer.className = 'kanban-column-content';
    cardContainer.style.cssText = `
      min-height: 300px;
      padding: 0.5rem;
      background: white;
      border-radius: 0 0 4px 4px;
      border: 1px solid #ddd;
    `;

    element.append(header, cardContainer);
    element.style.cssText = `
      background: #f9f9f9;
      border-radius: 4px;
      overflow: hidden;
    `;

    return element;
  }

  updateDOM(prevNode: ColumnNode, dom: HTMLElement): boolean {
    if (prevNode.__title !== this.__title) {
      const header = dom.querySelector('.kanban-column-header');
      if (header) {
        header.textContent = this.__title;
      }
      return true;
    }
    return false;
  }

  getDOMSlot(element: HTMLElement): ElementDOMSlot {
    const cardContainer = element.querySelector('.kanban-column-content') as HTMLElement;
    return super.getDOMSlot(element).withElement(cardContainer);
  }

  static importJSON(serializedNode: SerializedColumnNode): ColumnNode {
    const {title} = serializedNode;
    return $createColumnNode(title);
  }

  exportJSON(): SerializedColumnNode {
    return {
      ...super.exportJSON(),
      type: 'kanban-column',
      title: this.__title,
      version: 1,
    };
  }

  canBeEmpty(): false {
    return false;
  }
}

export function $createColumnNode(title: string): ColumnNode {
  return $applyNodeReplacement(new ColumnNode(title));
}

export function $isColumnNode(
  node: LexicalNode | null | undefined,
): node is ColumnNode {
  return node instanceof ColumnNode;
}
```

#### Step 1.3: Create CardNode

**File**: `src/nodes/CardNode.ts`

```typescript
import {
  $applyNodeReplacement,
  ElementNode,
  LexicalNode,
  NodeKey,
  SerializedElementNode,
  Spread,
} from 'lexical';
import {ElementDOMSlot} from 'lexical';

export type SerializedCardNode = Spread<
  {
    type: 'kanban-card';
    id: string;
    version: 1;
  },
  SerializedElementNode
>;

export class CardNode extends ElementNode {
  __id: string;

  constructor(id?: string, key?: NodeKey) {
    super(key);
    this.__id = id || Math.random().toString(36).substr(2, 9);
  }

  static getType(): string {
    return 'kanban-card';
  }

  static clone(node: CardNode): CardNode {
    return new CardNode(node.__id, node.__key);
  }

  getId(): string {
    return this.__id;
  }

  createDOM(): HTMLElement {
    const element = document.createElement('div');
    element.className = 'kanban-card';
    element.style.cssText = `
      background: white;
      border: 1px solid #ddd;
      border-radius: 4px;
      padding: 0.75rem;
      margin-bottom: 0.5rem;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
      cursor: text;
      transition: box-shadow 0.2s;
    `;
    element.setAttribute('data-card-id', this.__id);
    
    // Add hover effect
    element.addEventListener('mouseenter', () => {
      element.style.boxShadow = '0 2px 6px rgba(0,0,0,0.15)';
    });
    element.addEventListener('mouseleave', () => {
      element.style.boxShadow = '0 1px 3px rgba(0,0,0,0.1)';
    });

    return element;
  }

  updateDOM(): false {
    return false;
  }

  getDOMSlot(element: HTMLElement): ElementDOMSlot {
    return super.getDOMSlot(element);
  }

  static importJSON(serializedNode: SerializedCardNode): CardNode {
    const {id} = serializedNode;
    return $createCardNode(id);
  }

  exportJSON(): SerializedCardNode {
    return {
      ...super.exportJSON(),
      type: 'kanban-card',
      id: this.__id,
      version: 1,
    };
  }

  canBeEmpty(): false {
    return false;
  }
}

export function $createCardNode(id?: string): CardNode {
  return $applyNodeReplacement(new CardNode(id));
}

export function $isCardNode(
  node: LexicalNode | null | undefined,
): node is CardNode {
  return node instanceof CardNode;
}
```

### Phase 2: Commands and Utilities

#### Step 2.1: Create Commands

**File**: `src/commands/KanbanCommands.ts`

```typescript
import {
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_EDITOR,
  createCommand,
  LexicalCommand,
} from 'lexical';
import {$createParagraphNode} from 'lexical';
import {
  $createKanbanBoardNode,
  $createColumnNode,
  $createCardNode,
  $isKanbanBoardNode,
  $isColumnNode,
  $isCardNode,
} from '../nodes';

export const INSERT_KANBAN_BOARD_COMMAND: LexicalCommand<void> = createCommand(
  'INSERT_KANBAN_BOARD_COMMAND',
);

export const ADD_KANBAN_COLUMN_COMMAND: LexicalCommand<string> = createCommand(
  'ADD_KANBAN_COLUMN_COMMAND',
);

export const ADD_KANBAN_CARD_COMMAND: LexicalCommand<{
  columnIndex: number;
  content?: string;
}> = createCommand('ADD_KANBAN_CARD_COMMAND');

export const MOVE_KANBAN_CARD_COMMAND: LexicalCommand<{
  cardId: string;
  fromColumnIndex: number;
  toColumnIndex: number;
  position: number;
}> = createCommand('MOVE_KANBAN_CARD_COMMAND');

// Command handlers
export function registerKanbanCommands(editor: LexicalEditor): () => void {
  const removeInsertBoardCommand = editor.registerCommand(
    INSERT_KANBAN_BOARD_COMMAND,
    () => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) {
        const kanbanBoard = $createKanbanBoardNode();
        
        // Create default columns
        const todoColumn = $createColumnNode('To Do');
        const inProgressColumn = $createColumnNode('In Progress');
        const doneColumn = $createColumnNode('Done');
        
        kanbanBoard.append(todoColumn, inProgressColumn, doneColumn);
        selection.insertNodes([kanbanBoard]);
      }
      return true;
    },
    COMMAND_PRIORITY_EDITOR,
  );

  const removeAddColumnCommand = editor.registerCommand(
    ADD_KANBAN_COLUMN_COMMAND,
    (title: string) => {
      // Implementation for adding a new column
      // This would need to find the board and append a new column
      return true;
    },
    COMMAND_PRIORITY_EDITOR,
  );

  const removeAddCardCommand = editor.registerCommand(
    ADD_KANBAN_CARD_COMMAND,
    ({columnIndex, content}) => {
      // Implementation for adding a new card to a specific column
      const card = $createCardNode();
      const paragraph = $createParagraphNode();
      if (content) {
        paragraph.append($createTextNode(content));
      }
      card.append(paragraph);
      
      // Find the target column and append the card
      // This would need logic to locate the correct column
      return true;
    },
    COMMAND_PRIORITY_EDITOR,
  );

  return () => {
    removeInsertBoardCommand();
    removeAddColumnCommand();
    removeAddCardCommand();
  };
}
```

### Phase 3: React Integration

#### Step 3.1: Create Plugin

**File**: `src/plugins/KanbanPlugin.tsx`

```typescript
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {$insertNodeToNearestRoot} from '@lexical/utils';
import {
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_EDITOR,
} from 'lexical';
import {useEffect} from 'react';

import {
  INSERT_KANBAN_BOARD_COMMAND,
  registerKanbanCommands,
} from '../commands/KanbanCommands';
import {
  KanbanBoardNode,
  ColumnNode,
  CardNode,
} from '../nodes';

export function KanbanPlugin(): null {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    if (!editor.hasNodes([KanbanBoardNode, ColumnNode, CardNode])) {
      throw new Error(
        'KanbanBoardPlugin: KanbanBoardNode, BoardColumnNode, or BoardCardNode not registered on editor',
      );
    }

    return registerKanbanCommands(editor);
  }, [editor]);

  return null;
}
```

#### Step 3.2: Create Toolbar Component

**File**: `src/components/KanbanToolbar.tsx`

```typescript
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {INSERT_KANBAN_BOARD_COMMAND} from '../commands/KanbanCommands';

export function KanbanToolbar(): JSX.Element {
  const [editor] = useLexicalComposerContext();

  const insertKanbanBoard = () => {
    editor.dispatchCommand(INSERT_KANBAN_BOARD_COMMAND, undefined);
  };

  return (
    <div className="kanban-toolbar">
      <button
        onClick={insertKanbanBoard}
        className="toolbar-button"
        type="button">
        📋 Insert Kanban Board
      </button>
    </div>
  );
}
```

### Phase 4: Drag and Drop (Optional Enhancement)

#### Step 4.1: Add Drag and Drop Support

```typescript
// In BoardCardNode.createDOM()
element.draggable = true;
element.addEventListener('dragstart', (e) => {
  e.dataTransfer?.setData('text/plain', this.__id);
  e.dataTransfer?.setData('application/kanban-card', this.__id);
});

// In BoardColumnNode.createDOM()
cardContainer.addEventListener('dragover', (e) => {
  e.preventDefault();
});

cardContainer.addEventListener('drop', (e) => {
  e.preventDefault();
  const cardId = e.dataTransfer?.getData('application/kanban-card');
  if (cardId) {
    // Dispatch move command
    editor.dispatchCommand(MOVE_KANBAN_CARD_COMMAND, {
      cardId,
      // ... other parameters
    });
  }
});
```

## Usage in Your Project

### Installation Steps

1. **Copy the node files** to your project's appropriate directory
2. **Register the nodes** in your Lexical editor configuration:

```typescript
const initialConfig = {
  namespace: 'MyEditor',
  nodes: [
    // ... other nodes
    KanbanBoardNode,
    ColumnNode,
    CardNode,
  ],
  onError: console.error,
};
```

3. **Add the plugin** to your LexicalComposer:

```jsx
<LexicalComposer initialConfig={initialConfig}>
  <KanbanPlugin />
  <KanbanToolbar />
  {/* ... other components */}
</LexicalComposer>
```

## LLM Prompts for Implementation

Implement all functionality in the KanbanPlugin directory, including nodes, commands, and React components. Use the following prompts to guide the implementation:


### Prompt 1: Basic Node Creation
```
I'm implementing a Kanban board in Lexical using the getDOMSlot API. Please help me create a [KanbanBoardNode/ColumnNode/CardNode] that:

1. Extends ElementNode properly
2. Uses getDOMSlot to control child insertion into the correct DOM location
3. Implements proper serialization/deserialization
4. Includes appropriate CSS styling for a Kanban board layout
5. Follows Lexical best practices for custom nodes

The node should be simple for now (we'll add features later).


```

### Prompt 2: Command Implementation
```
I need to create Lexical commands for my Kanban board implementation. Please help me create commands for:

1. INSERT_KANBAN_BOARD_COMMAND - Insert a new board with default columns
2. ADD_KANBAN_COLUMN_COMMAND - Add a new column to an existing board
3. ADD_KANBAN_CARD_COMMAND - Add a new card to a specific column
4. MOVE_KANBAN_CARD_COMMAND - Move a card between columns

Each command should:
- Follow Lexical command patterns
- Handle proper node insertion and removal
- Work with the editor's selection system
- Include proper error handling
- Support undo/redo functionality
```

### Prompt 3: React Integration
```
I need to create React components for my Lexical Kanban board. Please help me create:

1. KanbanPlugin - Registers nodes and commands
2. KanbanToolbar - Provides UI controls for inserting boards and managing content
3. Integration with @lexical/react components

The components should:
- Use Lexical React hooks properly
- Handle command dispatching
- Provide a clean user interface
- Include TypeScript types
- Follow React best practices
```

### Prompt 4: Drag and Drop Enhancement
```
I want to add drag and drop functionality to my Lexical Kanban board. Please help me implement:

1. Draggable cards with proper data transfer
2. Drop zones in columns
3. Visual feedback during drag operations
4. Command dispatching for card moves
5. Integration with Lexical's update system

The implementation should:
- Work with the existing node structure
- Maintain Lexical's selection and focus behavior
- Support undo/redo for drag operations
- Handle edge cases gracefully
```

### Prompt 5: Styling and Polish
```
Please help me improve the visual design and user experience of my Lexical Kanban board:

1. Create modern, responsive CSS for the board layout
2. Add hover effects and transitions
3. Implement proper focus styles for accessibility
4. Add visual indicators for drag and drop
5. Ensure the design works well with Lexical's editor styling

The styling should:
- Use CSS Grid or Flexbox for layout
- Be responsive and mobile-friendly
- Follow accessibility guidelines
- Integrate well with existing editor themes
- Include smooth animations and transitions
```
