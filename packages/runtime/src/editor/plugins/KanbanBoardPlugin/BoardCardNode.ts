import {
  $applyNodeReplacement,
  ElementNode,
  LexicalNode,
  NodeKey,
  SerializedElementNode,
  Spread,
} from 'lexical';
import {ElementDOMSlot} from 'lexical';

export interface CardData {
  title: string;
  owner?: string;
  dueDate?: string;
  priority?: 'low' | 'medium' | 'high';
  description?: string;
}

export type SerializedCardNode = Spread<
  {
    type: 'kanban-card';
    id: string;
    data?: CardData;
    version: 1;
  },
  SerializedElementNode
>;

export class BoardCardNode extends ElementNode {
  __id: string;
  __data: CardData;

  constructor(id?: string, data?: CardData, key?: NodeKey) {
    super(key);
    this.__id = id || Math.random().toString(36).substr(2, 9);
    this.__data = data || { title: '' };
  }

  static getType(): string {
    return 'kanban-card';
  }

  static clone(node: BoardCardNode): BoardCardNode {
    return new BoardCardNode(node.__id, node.__data, node.__key);
  }

  getId(): string {
    return this.__id;
  }

  getData(): CardData {
    return this.__data;
  }

  setData(data: CardData): void {
    const writable = this.getWritable();
    writable.__data = data;
  }

  getBoardConfig() {
    // Traverse up to find the board node and get its config
    let parent = this.getParent();
    while (parent) {
      if (parent.getType() === 'kanban-board') {
        return (parent as any).getConfig?.();
      }
      parent = parent.getParent();
    }
    return null;
  }

  createDOM(): HTMLElement {
    const element = document.createElement('div');
    element.className = 'kanban-card';
    element.setAttribute('data-card-id', this.__id);
    element.draggable = true;
    element.contentEditable = 'false';

    // Card header with edit and delete buttons
    const cardHeader = document.createElement('div');
    cardHeader.className = 'kanban-card-header';
    cardHeader.contentEditable = 'false';
    
    // Edit button
    const editButton = document.createElement('button');
    editButton.className = 'kanban-card-edit';
    editButton.innerHTML = '<span class="material-symbols-outlined">edit</span>';
    editButton.type = 'button';
    editButton.title = 'Edit card';
    editButton.draggable = false;

    editButton.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();

      window.dispatchEvent(new CustomEvent('board-edit-card', {
        detail: {
          cardNodeKey: this.getKey(),
          cardId: this.__id,
          currentData: this.__data
        }
      }));
    });

    editButton.addEventListener('mousedown', (e) => {
      e.stopPropagation();
    });

    // Delete button
    const deleteButton = document.createElement('button');
    deleteButton.className = 'kanban-card-delete';
    deleteButton.innerHTML = '<span class="material-symbols-outlined">close</span>';
    deleteButton.type = 'button';
    deleteButton.title = 'Delete card';
    deleteButton.draggable = false;

    deleteButton.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();

      window.dispatchEvent(new CustomEvent('board-delete-card', {
        detail: {
          cardNodeKey: this.getKey(),
          cardId: this.__id
        }
      }));
    });

    deleteButton.addEventListener('mousedown', (e) => {
      e.stopPropagation();
    });
    
    cardHeader.appendChild(editButton);
    cardHeader.appendChild(deleteButton);
    element.appendChild(cardHeader);
    
    // Card content area
    const cardContent = document.createElement('div');
    cardContent.className = 'kanban-card-content';
    cardContent.contentEditable = 'true';
    element.appendChild(cardContent);

    // Card metadata (owner, due date, priority) - check board config for visibility
    const cardMeta = document.createElement('div');
    cardMeta.className = 'kanban-card-meta';
    cardMeta.contentEditable = 'false';
    
    // Get board config to check visible fields
    const boardConfig = this.getBoardConfig();
    const visibleFields = boardConfig?.visibleFields || { owner: true, dueDate: true, priority: true, description: false };
    
    if (visibleFields.owner && this.__data.owner) {
      const owner = document.createElement('span');
      owner.className = 'kanban-card-owner';
      owner.innerHTML = `<span class="material-symbols-outlined">person</span> ${this.__data.owner}`;
      cardMeta.appendChild(owner);
    }
    
    if (visibleFields.dueDate && this.__data.dueDate) {
      const dueDate = document.createElement('span');
      dueDate.className = 'kanban-card-due';
      dueDate.innerHTML = `<span class="material-symbols-outlined">calendar_today</span> ${this.__data.dueDate}`;
      cardMeta.appendChild(dueDate);
    }
    
    if (visibleFields.priority && this.__data.priority) {
      const priority = document.createElement('span');
      priority.className = `kanban-card-priority kanban-card-priority-${this.__data.priority}`;
      const priorityIcons = {
        low: '<span class="material-symbols-outlined">low_priority</span>',
        medium: '<span class="material-symbols-outlined">priority_high</span>',
        high: '<span class="material-symbols-outlined">error</span>'
      };
      priority.innerHTML = priorityIcons[this.__data.priority];
      cardMeta.appendChild(priority);
    }

    if (cardMeta.children.length > 0) {
      element.appendChild(cardMeta);
    }

    // Description (shown after metadata if enabled)
    if (visibleFields.description && this.__data.description) {
      const descriptionDiv = document.createElement('div');
      descriptionDiv.className = 'kanban-card-description';
      descriptionDiv.contentEditable = 'false';
      descriptionDiv.textContent = this.__data.description;
      element.appendChild(descriptionDiv);
    }

    // Add drag events
    element.addEventListener('dragstart', (e) => {
      element.classList.add('dragging');
      const dataTransfer = e.dataTransfer;
      if (dataTransfer) {
        dataTransfer.setData('application/x-kanban-card', this.__id);
        dataTransfer.setData('text/plain', this.__id);
        dataTransfer.effectAllowed = 'move';
      }
    });

    element.addEventListener('dragend', (e) => {
      element.classList.remove('dragging');
    });

    return element;
  }

  updateDOM(prevNode: BoardCardNode, dom: HTMLElement): boolean {
    // Update if data changed
    if (prevNode.__data !== this.__data) {
      // Get board config once for all updates
      const boardConfig = this.getBoardConfig();
      const visibleFields = boardConfig?.visibleFields || { owner: true, dueDate: true, priority: true, description: false };

      // Update metadata display
      const cardMeta = dom.querySelector('.kanban-card-meta');
      if (cardMeta) {
        cardMeta.innerHTML = '';
        
        if (visibleFields.owner && this.__data.owner) {
          const owner = document.createElement('span');
          owner.className = 'kanban-card-owner';
          owner.innerHTML = `<span class="material-symbols-outlined">person</span> ${this.__data.owner}`;
          cardMeta.appendChild(owner);
        }
        
        if (visibleFields.dueDate && this.__data.dueDate) {
          const dueDate = document.createElement('span');
          dueDate.className = 'kanban-card-due';
          dueDate.innerHTML = `<span class="material-symbols-outlined">calendar_today</span> ${this.__data.dueDate}`;
          cardMeta.appendChild(dueDate);
        }
        
        if (visibleFields.priority && this.__data.priority) {
          const priority = document.createElement('span');
          priority.className = `kanban-card-priority kanban-card-priority-${this.__data.priority}`;
          const priorityIcons = {
            low: '<span class="material-symbols-outlined">low_priority</span>',
            medium: '<span class="material-symbols-outlined">priority_high</span>',
            high: '<span class="material-symbols-outlined">error</span>'
          };
          priority.innerHTML = priorityIcons[this.__data.priority];
          cardMeta.appendChild(priority);
        }
      }

      // Update description
      let descriptionDiv = dom.querySelector('.kanban-card-description') as HTMLElement;
      if (visibleFields.description && this.__data.description) {
        if (!descriptionDiv) {
          descriptionDiv = document.createElement('div');
          descriptionDiv.className = 'kanban-card-description';
          descriptionDiv.contentEditable = 'false';
          dom.appendChild(descriptionDiv);
        }
        descriptionDiv.textContent = this.__data.description;
      } else if (descriptionDiv) {
        descriptionDiv.remove();
      }

      return true;
    }
    return false;
  }

  getDOMSlot(element: HTMLElement): ElementDOMSlot {
    const contentArea = element.querySelector('.kanban-card-content') as HTMLElement;
    return super.getDOMSlot(element).withElement(contentArea);
  }

  static importJSON(serializedNode: SerializedCardNode): BoardCardNode {
    const {id, data} = serializedNode;
    return $createCardNode(id, data);
  }

  exportJSON(): SerializedCardNode {
    return {
      ...super.exportJSON(),
      type: 'kanban-card',
      id: this.__id,
      data: this.__data,
      version: 1,
    };
  }

  canBeEmpty(): false {
    return false;
  }
}

export function $createCardNode(id?: string, data?: CardData): BoardCardNode {
  return $applyNodeReplacement(new BoardCardNode(id, data));
}

export function $isCardNode(
  node: LexicalNode | null | undefined,
): node is BoardCardNode {
  return node instanceof BoardCardNode;
}
