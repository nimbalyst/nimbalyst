import {
  $applyNodeReplacement,
  $isElementNode,
  ElementNode,
  LexicalNode,
  NodeKey,
  SerializedElementNode,
  Spread,
} from 'lexical';
import {ElementDOMSlot} from 'lexical';
import { BoardConfig } from './BoardConfigDialog';
import './Board.css';

export type SerializedKanbanBoardNode = Spread<
  {
    type: 'kanban-board';
    version: 1;
    config?: BoardConfig;
  },
  SerializedElementNode
>;

export class KanbanBoardNode extends ElementNode {
  __config: BoardConfig | null;

  constructor(config?: BoardConfig, key?: NodeKey) {
    super(key);
    this.__config = config || null;
  }

  static getType(): string {
    return 'kanban-board';
  }

  static clone(node: KanbanBoardNode): KanbanBoardNode {
    return new KanbanBoardNode(node.__config || undefined, node.__key);
  }

  getConfig(): BoardConfig | null {
    return this.__config;
  }

  setConfig(config: BoardConfig): void {
    const writable = this.getWritable();
    writable.__config = config;
    // Mark all descendant card nodes as dirty to force re-render
    this.getChildren().forEach(child => {
      this.markDescendantsDirty(child);
    });
  }

  private markDescendantsDirty(node: LexicalNode): void {
    if ($isElementNode(node)) {
      node.getChildren().forEach(child => {
        this.markDescendantsDirty(child);
      });
    }
    // Force writable to mark as dirty
    node.getWritable();
  }

  createDOM(): HTMLElement {
    // Create the board element (this is what gets returned and becomes the main element)
    const element = document.createElement('div');
    element.className = 'kanban-board';
    element.setAttribute('data-lexical-node-key', this.getKey());

    return element;
  }

  updateDOM(): false {
    return false;
  }

  // Remove getDOMSlot override - use default behavior

  static importJSON(serializedNode: SerializedKanbanBoardNode): KanbanBoardNode {
    return $createBoardNode(serializedNode.config);
  }

  exportJSON(): SerializedKanbanBoardNode {
    return {
      ...super.exportJSON(),
      type: 'kanban-board',
      version: 1,
      config: this.__config || undefined,
    };
  }

  canBeEmpty(): true {
    return true;
  }

  isShadowRoot(): true {
    return true;
  }
}

export function $createBoardNode(config?: BoardConfig): KanbanBoardNode {
  return $applyNodeReplacement(new KanbanBoardNode(config));
}

export function $isBoardNode(
  node: LexicalNode | null | undefined,
): node is KanbanBoardNode {
  return node instanceof KanbanBoardNode;
}
