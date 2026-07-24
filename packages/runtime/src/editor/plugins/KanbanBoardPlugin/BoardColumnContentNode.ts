import {
  $applyNodeReplacement,
  ElementNode,
  LexicalNode,
  NodeKey,
  SerializedElementNode,
  Spread,
} from 'lexical';
import {ElementDOMSlot} from 'lexical';

export type SerializedColumnContentNode = Spread<
  {
    type: 'kanban-column-content';
    version: 1;
  },
  SerializedElementNode
>;

export class BoardColumnContentNode extends ElementNode {
  constructor(key?: NodeKey) {
    super(key);
  }

  static getType(): string {
    return 'kanban-column-content';
  }

  static clone(node: BoardColumnContentNode): BoardColumnContentNode {
    return new BoardColumnContentNode(node.__key);
  }

  createDOM(): HTMLElement {
    const element = document.createElement('div');
    element.className = 'kanban-column-content';
    element.contentEditable = 'false';

    // Add card button
    const addButton = document.createElement('button');
    addButton.className = 'kanban-add-card-button';
    addButton.textContent = '+ Add card';
    addButton.type = 'button';
    addButton.contentEditable = 'false';
    
    // Add button click handler
    addButton.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      
      // Dispatch custom event to add a new card
      window.dispatchEvent(new CustomEvent('board-add-card', {
        detail: { 
          columnElement: element.closest('.kanban-column'),
          contentNodeKey: this.getKey()
        }
      }));
    });
    
    element.appendChild(addButton);
    return element;
  }

  updateDOM(): false {
    return false;
  }

  getDOMSlot(element: HTMLElement): ElementDOMSlot {
    // Create a container for cards before the add button
    let cardsContainer = element.querySelector('.kanban-cards-container') as HTMLElement;
    if (!cardsContainer) {
      cardsContainer = document.createElement('div');
      cardsContainer.className = 'kanban-cards-container';
      cardsContainer.contentEditable = 'false';
      // Insert before the add button
      const addButton = element.querySelector('.kanban-add-card-button');
      if (addButton) {
        element.insertBefore(cardsContainer, addButton);
      } else {
        element.appendChild(cardsContainer);
      }
    }
    return super.getDOMSlot(element).withElement(cardsContainer);
  }

  static importJSON(serializedNode: SerializedColumnContentNode): BoardColumnContentNode {
    return $createColumnContentNode();
  }

  exportJSON(): SerializedColumnContentNode {
    return {
      ...super.exportJSON(),
      type: 'kanban-column-content',
      version: 1,
    };
  }

  canBeEmpty(): true {
    return true;
  }
}

export function $createColumnContentNode(): BoardColumnContentNode {
  return $applyNodeReplacement(new BoardColumnContentNode());
}

export function $isColumnContentNode(
  node: LexicalNode | null | undefined,
): node is BoardColumnContentNode {
  return node instanceof BoardColumnContentNode;
}
