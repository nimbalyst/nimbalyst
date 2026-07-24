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
    version: 1;
  },
  SerializedElementNode
>;

export class BoardColumnNode extends ElementNode {
  constructor(key?: NodeKey) {
    super(key);
  }

  static getType(): string {
    return 'kanban-column';
  }

  static clone(node: BoardColumnNode): BoardColumnNode {
    return new BoardColumnNode(node.__key);
  }

  createDOM(): HTMLElement {
    const element = document.createElement('div');
    element.className = 'kanban-column';
    element.contentEditable = 'false';
    return element;
  }

  updateDOM(): false {
    return false;
  }

  getDOMSlot(element: HTMLElement): ElementDOMSlot {
    return super.getDOMSlot(element);
  }

  static importJSON(serializedNode: SerializedColumnNode): BoardColumnNode {
    return $createColumnNode();
  }

  exportJSON(): SerializedColumnNode {
    return {
      ...super.exportJSON(),
      type: 'kanban-column',
      version: 1,
    };
  }

  canBeEmpty(): true {
    return true;
  }
}

export function $createColumnNode(): BoardColumnNode {
  return $applyNodeReplacement(new BoardColumnNode());
}

export function $isColumnNode(
  node: LexicalNode | null | undefined,
): node is BoardColumnNode {
  return node instanceof BoardColumnNode;
}
