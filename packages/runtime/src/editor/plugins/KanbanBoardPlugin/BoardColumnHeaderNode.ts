import {
  $applyNodeReplacement,
  ElementNode,
  LexicalNode,
  NodeKey,
  SerializedElementNode,
  Spread,
} from 'lexical';
import {ElementDOMSlot} from 'lexical';

export type SerializedColumnHeaderNode = Spread<
  {
    type: 'kanban-column-header';
    version: 1;
  },
  SerializedElementNode
>;

export class BoardColumnHeaderNode extends ElementNode {
  constructor(key?: NodeKey) {
    super(key);
  }

  static getType(): string {
    return 'kanban-column-header';
  }

  static clone(node: BoardColumnHeaderNode): BoardColumnHeaderNode {
    return new BoardColumnHeaderNode(node.__key);
  }

  createDOM(): HTMLElement {
    const element = document.createElement('div');
    element.className = 'kanban-column-header';
    element.contentEditable = 'false';

    // Drag handle for column reordering
    const dragHandle = document.createElement('div');
    dragHandle.className = 'kanban-column-drag-handle';
    dragHandle.innerHTML = '<span class="material-symbols-outlined">drag_indicator</span>';
    dragHandle.title = 'Drag to reorder column';
    dragHandle.contentEditable = 'false';

    // Header content area (where lexical nodes go)
    const headerContent = document.createElement('div');
    headerContent.className = 'kanban-column-header-content';
    headerContent.contentEditable = 'true';

    // Column actions container
    const columnActions = document.createElement('div');
    columnActions.className = 'kanban-column-actions';
    columnActions.contentEditable = 'false';

    // Delete button
    const deleteButton = document.createElement('button');
    deleteButton.className = 'kanban-column-delete';
    deleteButton.innerHTML = '<span class="material-symbols-outlined">close</span>';
    deleteButton.type = 'button';
    deleteButton.title = 'Delete column';
    deleteButton.contentEditable = 'false';
    
    deleteButton.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      
      window.dispatchEvent(new CustomEvent('board-delete-column', {
        detail: {
          columnElement: element.closest('.kanban-column'),
          columnNodeKey: this.getKey()
        }
      }));
    });

    columnActions.appendChild(deleteButton);
    element.append(dragHandle, headerContent, columnActions);
    
    // Make the entire column draggable via the header
    const column = element.parentElement || element.closest('.kanban-column');
    if (column) {
      column.setAttribute('draggable', 'true');
    }
    
    // Add drag event handlers to the drag handle
    dragHandle.addEventListener('mousedown', (e) => {
      const column = element.closest('.kanban-column') as HTMLElement;
      if (column) {
        column.setAttribute('draggable', 'true');
      }
    });
    
    // Add drag events to the parent column element
    element.addEventListener('dragstart', (e) => {
      const column = element.closest('.kanban-column') as HTMLElement;
      if (column && e.dataTransfer) {
        column.classList.add('dragging');
        e.dataTransfer.setData('application/x-kanban-column', this.getKey());
        e.dataTransfer.effectAllowed = 'move';
      }
    });
    
    element.addEventListener('dragend', (e) => {
      const column = element.closest('.kanban-column') as HTMLElement;
      if (column) {
        column.classList.remove('dragging');
      }
    });
    
    return element;
  }

  updateDOM(): false {
    return false;
  }

  getDOMSlot(element: HTMLElement): ElementDOMSlot {
    const headerContent = element.querySelector('.kanban-column-header-content') as HTMLElement;
    return super.getDOMSlot(element).withElement(headerContent);
  }

  static importJSON(serializedNode: SerializedColumnHeaderNode): BoardColumnHeaderNode {
    return $createColumnHeaderNode();
  }

  exportJSON(): SerializedColumnHeaderNode {
    return {
      ...super.exportJSON(),
      type: 'kanban-column-header',
      version: 1,
    };
  }

  canBeEmpty(): false {
    return false;
  }
}

export function $createColumnHeaderNode(): BoardColumnHeaderNode {
  return $applyNodeReplacement(new BoardColumnHeaderNode());
}

export function $isColumnHeaderNode(
  node: LexicalNode | null | undefined,
): node is BoardColumnHeaderNode {
  return node instanceof BoardColumnHeaderNode;
}
