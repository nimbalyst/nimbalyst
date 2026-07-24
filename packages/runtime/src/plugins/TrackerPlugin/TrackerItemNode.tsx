import {
  $applyNodeReplacement,
  $createParagraphNode,
  $createTextNode,
  ElementNode,
  LexicalNode,
  NodeKey,
  ParagraphNode,
  RangeSelection,
  SerializedElementNode,
  Spread,
  $getNodeByKey,
  DOMExportOutput,
  DOMConversionMap,
  DOMConversionOutput,
} from 'lexical';
import { ElementDOMSlot } from 'lexical';

export type TrackerItemType = 'plan' | 'bug' | 'task' | 'idea' | 'decision' | 'automation';
export type TrackerItemStatus = 'to-do' | 'in-progress' | 'in-review' | 'done' | 'blocked' | 'proposed' | 'in-discussion' | 'decided' | 'implemented' | 'rejected' | 'superseded';
export type TrackerItemPriority = 'low' | 'medium' | 'high' | 'critical';

export type TrackerItemData = {
  id: string;
  type: TrackerItemType;
  title: string;
  description?: string;
  status: TrackerItemStatus;
  priority?: TrackerItemPriority;
  owner?: string;
  tags?: string[];
  created?: string;
  updated?: string;
};

export type SerializedTrackerItemNode = Spread<
  {
    type: 'tracker-item';
    version: 1;
    data: TrackerItemData;
  },
  SerializedElementNode
>;

function convertTrackerItemElement(domNode: HTMLElement): DOMConversionOutput | null {
  const type = domNode.getAttribute('data-tracker-type') as TrackerItemType;
  const status = domNode.getAttribute('data-tracker-status') as TrackerItemStatus;
  const checkbox = domNode.querySelector('.tracker-checkbox') as HTMLInputElement;
  const id = checkbox?.getAttribute('data-tracker-id') || `tracker-${Date.now()}`;

  // Extract priority if present (now inside type badge)
  const priorityIcon = domNode.querySelector('.tracker-priority-icon');
  let priority: TrackerItemPriority | undefined;
  if (priorityIcon) {
    priority = priorityIcon.getAttribute('data-priority') as TrackerItemPriority;
  }

  // Extract content text
  const contentArea = domNode.querySelector('.tracker-content');
  const title = contentArea?.textContent || '';

  if (!type || !status) {
    return null;
  }

  const data: TrackerItemData = {
    id,
    type,
    title,
    status,
    priority,
  };

  const node = $createTrackerItemNode(data);
  return { node };
}

export class TrackerItemNode extends ElementNode {
  __data: TrackerItemData;

  constructor(data: TrackerItemData, key?: NodeKey) {
    super(key);
    this.__data = data;
  }

  static getType(): string {
    return 'tracker-item';
  }

  static clone(node: TrackerItemNode): TrackerItemNode {
    return new TrackerItemNode({ ...node.__data }, node.__key);
  }

  static importDOM(): DOMConversionMap | null {
    return {
      span: (domNode: HTMLElement) => {
        if (!domNode.classList.contains('tracker-item-container')) {
          return null;
        }
        return {
          conversion: convertTrackerItemElement,
          priority: 1,
        };
      },
    };
  }

  createDOM(): HTMLElement {
    const container = document.createElement('span');
    container.className = 'tracker-item-container';
    container.setAttribute('data-tracker-type', this.__data.type);
    container.setAttribute('data-tracker-status', this.__data.status);

    // Custom checkbox (styled for type/status)
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = `tracker-checkbox tracker-${this.__data.type}`;
    checkbox.checked = this.__data.status === 'done';
    checkbox.setAttribute('data-tracker-id', this.__data.id);
    checkbox.contentEditable = 'false';

    // Type badge (e.g., "@bug", "@task", "@plan") with icons inside
    const typeBadge = document.createElement('span');
    typeBadge.className = `tracker-type-badge tracker-type-${this.__data.type}`;
    typeBadge.contentEditable = 'false';

    // Add priority icon if set
    if (this.__data.priority) {
      const priorityIcon = document.createElement('span');
      priorityIcon.className = 'material-symbols-outlined tracker-priority-icon';
      const priorityIcons: Record<string, string> = {
        'low': 'signal_cellular_alt_1_bar',
        'medium': 'signal_cellular_alt_2_bar',
        'high': 'signal_cellular_alt',
        'critical': 'signal_cellular_alt',
      };
      priorityIcon.textContent = priorityIcons[this.__data.priority] || 'signal_cellular_alt_2_bar';
      priorityIcon.setAttribute('data-priority', this.__data.priority);
      typeBadge.appendChild(priorityIcon);
    }

    // Add status icon
    const statusIcon = document.createElement('span');
    statusIcon.className = 'material-symbols-outlined tracker-status-icon';
    const statusIcons: Record<string, string> = {
      'to-do': 'panorama_fish_eye',
      'in-progress': 'donut_small',
      'in-review': 'trip_origin',
      'done': 'check_circle',
      'blocked': 'cancel',
    };
    statusIcon.textContent = statusIcons[this.__data.status] || 'panorama_fish_eye';
    statusIcon.setAttribute('data-status', this.__data.status);
    typeBadge.appendChild(statusIcon);

    // Add type text
    const typeText = document.createElement('span');
    typeText.textContent = `#${this.__data.type}`;
    typeBadge.appendChild(typeText);

    // Content area where children render - Lexical handles editability of children
    const content = document.createElement('span');
    content.className = 'tracker-content';
    content.setAttribute('data-lexical-slot', 'content');

    // Append in order: checkbox, type badge (with icons inside), content
    container.appendChild(checkbox);
    container.appendChild(typeBadge);
    container.appendChild(content);

    // Add click handler for checkbox
    checkbox.addEventListener('change', (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Dispatch custom event that the plugin will handle
      window.dispatchEvent(new CustomEvent('tracker-item-toggle', {
        detail: { nodeKey: this.getKey(), checked: checkbox.checked }
      }));
    });

    // Add click handler for type badge to open metadata editor
    typeBadge.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      window.dispatchEvent(new CustomEvent('tracker-item-edit', {
        detail: {
          nodeKey: this.getKey(),
          data: this.__data,
          target: typeBadge
        }
      }));
    });

    return container;
  }

  updateDOM(prevNode: TrackerItemNode, dom: HTMLElement): boolean {
    // Update if data changed
    if (prevNode.__data !== this.__data) {
      dom.setAttribute('data-tracker-type', this.__data.type);
      dom.setAttribute('data-tracker-status', this.__data.status);

      const checkbox = dom.querySelector('.tracker-checkbox') as HTMLInputElement;
      if (checkbox) {
        checkbox.checked = this.__data.status === 'done';
        checkbox.className = `tracker-checkbox tracker-${this.__data.type}`;
      }

      // Update type badge class
      const typeBadge = dom.querySelector('.tracker-type-badge');
      if (typeBadge) {
        typeBadge.className = `tracker-type-badge tracker-type-${this.__data.type}`;

        // Update priority icon
        let priorityIcon = typeBadge.querySelector('.tracker-priority-icon');
        if (this.__data.priority) {
          const priorityIcons: Record<string, string> = {
            'low': 'signal_cellular_alt_1_bar',
            'medium': 'signal_cellular_alt_2_bar',
            'high': 'signal_cellular_alt',
            'critical': 'signal_cellular_alt',
          };

          if (!priorityIcon) {
            priorityIcon = document.createElement('span');
            priorityIcon.className = 'material-symbols-outlined tracker-priority-icon';
            priorityIcon.textContent = priorityIcons[this.__data.priority] || 'signal_cellular_alt_2_bar';
            priorityIcon.setAttribute('data-priority', this.__data.priority);
            typeBadge.prepend(priorityIcon);
          } else {
            priorityIcon.textContent = priorityIcons[this.__data.priority] || 'signal_cellular_alt_2_bar';
            priorityIcon.setAttribute('data-priority', this.__data.priority);
          }
        } else if (priorityIcon) {
          priorityIcon.remove();
        }

        // Update status icon
        const statusIcon = typeBadge.querySelector('.tracker-status-icon');
        if (statusIcon) {
          const statusIcons: Record<string, string> = {
            'to-do': 'panorama_fish_eye',
            'in-progress': 'donut_small',
            'in-review': 'trip_origin',
            'done': 'check_circle',
            'blocked': 'cancel',
          };
          statusIcon.textContent = statusIcons[this.__data.status] || 'panorama_fish_eye';
          statusIcon.setAttribute('data-status', this.__data.status);
        }
      }

      return true;
    }
    return false;
  }

  getDOMSlot(element: HTMLElement): ElementDOMSlot {
    const contentArea = element.querySelector('.tracker-content') as HTMLElement;
    return super.getDOMSlot(element).withElement(contentArea);
  }

  static importJSON(serializedNode: SerializedTrackerItemNode): TrackerItemNode {
    const node = $createTrackerItemNode(serializedNode.data);
    node.setFormat(serializedNode.format);
    node.setIndent(serializedNode.indent);
    node.setDirection(serializedNode.direction);
    return node;
  }

  exportJSON(): SerializedTrackerItemNode {
    return {
      ...super.exportJSON(),
      type: 'tracker-item',
      version: 1,
      data: this.__data,
    };
  }

  exportDOM(): DOMExportOutput {
    const element = this.createDOM();
    return { element };
  }

  getData(): TrackerItemData {
    const self = this.getLatest();
    return self.__data;
  }

  setData(data: TrackerItemData): void {
    const writable = this.getWritable();
    writable.__data = data;
  }

  canBeEmpty(): boolean {
    return true;
  }

  canInsertTextBefore(): boolean {
    return true;
  }

  canInsertTextAfter(): boolean {
    return true;
  }

  extractWithChild(): boolean {
    return true;
  }

  // This is the key method - it allows the node to be merged when empty
  // rather than deleted. This is how QuoteNode and ListItemNode handle it.
  canMergeWhenEmpty(): boolean {
    return true;
  }

  // Ensure node always has at least an empty text child to hold the cursor
  normalizeChildren(): boolean {
    const children = this.getChildren();

    if (children.length === 0) {
      // Add empty text node so cursor can be positioned inside
      const emptyText = $createTextNode('');
      this.append(emptyText);
      return true;
    }

    return false;
  }

  // Prevent collapse - keep tracker node even when backspacing at start
  collapseAtStart(): boolean {
    return false;
  }

  // Without this, pressing Enter on a tracker-item line at the end of the
  // document is a no-op: Lexical's default RichText KEY_ENTER_COMMAND handler
  // calls insertNewAfter on the parent ElementNode and bails when the result
  // is null. The base ElementNode implementation returns null, so the cursor
  // has nowhere to go and the keypress is silently swallowed. Mirror the
  // HeadingNode/QuoteNode pattern from @lexical/rich-text: a new empty
  // paragraph below the tracker item. Tested behavior for #263.
  insertNewAfter(
    _selection: RangeSelection | null,
    restoreSelection = true,
  ): ParagraphNode {
    const newElement = $createParagraphNode();
    const direction = this.getDirection();
    newElement.setDirection(direction);
    this.insertAfter(newElement, restoreSelection);
    return newElement;
  }

}

export function $createTrackerItemNode(data: TrackerItemData): TrackerItemNode {
  return $applyNodeReplacement(new TrackerItemNode(data));
}

export function $getTrackerItemNode(nodeKey: string): TrackerItemNode | null {
  const node = $getNodeByKey(nodeKey);
  return $isTrackerItemNode(node) ? node : null;
}

export function $isTrackerItemNode(
  node: LexicalNode | null | undefined,
): node is TrackerItemNode {
  return node instanceof TrackerItemNode;
}
