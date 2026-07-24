import {
  ElementNode,
  NodeKey,
  SerializedElementNode,
  Spread,
  $applyNodeReplacement,
  LexicalNode,
  ElementDOMSlot,
} from 'lexical';

export type SerializedBoardHeaderNode = Spread<
  {
    type: 'board-header';
    version: 1;
  },
  SerializedElementNode
>;

export class BoardHeaderNode extends ElementNode {
  static getType(): string {
    return 'board-header';
  }

  static clone(node: BoardHeaderNode): BoardHeaderNode {
    return new BoardHeaderNode(node.__key);
  }

  constructor(key?: NodeKey) {
    super(key);
  }

  createDOM(): HTMLElement {
    const element = document.createElement('div');
    element.className = 'kanban-board-header';
    element.contentEditable = 'false';

    // Create title element (will be populated by child nodes)
    const titleContainer = document.createElement('div');
    titleContainer.className = 'kanban-board-title-container';
    titleContainer.contentEditable = 'true';

    // Create controls container for buttons
    const controlsContainer = document.createElement('div');
    controlsContainer.className = 'kanban-board-controls';
    controlsContainer.contentEditable = 'false';

    // Create config button
    const configButton = document.createElement('button');
    configButton.className = 'board-settings-button';
    configButton.contentEditable = 'false';
    configButton.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/>
      </svg>
    `;

    // Add config button click handler
    configButton.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      
      // Find the board node
      const boardElement = element.closest('.kanban-board');
      if (boardElement) {
        const boardNodeKey = boardElement.getAttribute('data-lexical-node-key');
        
        // Dispatch custom event to open config dialog
        window.dispatchEvent(new CustomEvent('board-configure', {
          detail: { 
            boardElement: boardElement,
            boardNodeKey: boardNodeKey,
          }
        }));
      }
    });

    // Add new column button
    const addColumnButton = document.createElement('button');
    addColumnButton.className = 'kanban-add-column-button';
    addColumnButton.innerHTML = '+ Add Column';
    addColumnButton.type = 'button';
    addColumnButton.contentEditable = 'false';
    
    addColumnButton.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      
      // Find the board node
      const boardElement = element.closest('.kanban-board');
      if (boardElement) {
        const boardNodeKey = boardElement.getAttribute('data-lexical-node-key');
        
        window.dispatchEvent(new CustomEvent('board-add-column', {
          detail: { 
            boardNodeKey: boardNodeKey
          }
        }));
      }
    });

    // Add buttons to controls container
    controlsContainer.appendChild(configButton);
    controlsContainer.appendChild(addColumnButton);
    
    // Add title and controls to header
    element.appendChild(titleContainer);
    element.appendChild(controlsContainer);
    
    return element;
  }

  updateDOM(): false {
    return false;
  }

  getDOMSlot(element: HTMLElement): ElementDOMSlot {
    const titleContainer = element.querySelector('.kanban-board-title-container');
    if (titleContainer) {
      return super.getDOMSlot(element).withElement(titleContainer as HTMLElement);
    }
    return super.getDOMSlot(element);
  }

  static importJSON(serializedNode: SerializedBoardHeaderNode): BoardHeaderNode {
    return $createBoardHeaderNode();
  }

  exportJSON(): SerializedBoardHeaderNode {
    return {
      ...super.exportJSON(),
      type: 'board-header',
      version: 1,
    };
  }
}

export function $createBoardHeaderNode(): BoardHeaderNode {
  return $applyNodeReplacement(new BoardHeaderNode());
}

export function $isBoardHeaderNode(
  node: LexicalNode | null | undefined,
): node is BoardHeaderNode {
  return node instanceof BoardHeaderNode;
}