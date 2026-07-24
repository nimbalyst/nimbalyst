import { LexicalEditor, LexicalNode } from 'lexical';

export interface DraggableBlockMenuItem {
  id: string;
  label: string;
  icon?: string; // Material Symbols icon name
  nodeTypes: string[]; // Node types this menu item applies to
  command: (editor: LexicalEditor, node: LexicalNode) => void;
  isVisible?: (node: LexicalNode) => boolean; // Optional visibility check
  order?: number; // Sort order for menu items
}

class DraggableBlockMenuRegistry {
  private static instance: DraggableBlockMenuRegistry;
  private menuItems: Map<string, DraggableBlockMenuItem> = new Map();
  private listeners: Set<() => void> = new Set();

  private constructor() {}

  static getInstance(): DraggableBlockMenuRegistry {
    if (!DraggableBlockMenuRegistry.instance) {
      DraggableBlockMenuRegistry.instance = new DraggableBlockMenuRegistry();
    }
    return DraggableBlockMenuRegistry.instance;
  }

  registerMenuItem(item: DraggableBlockMenuItem): () => void {
    this.menuItems.set(item.id, item);
    this.notifyListeners();
    
    // Return unregister function
    return () => {
      this.menuItems.delete(item.id);
      this.notifyListeners();
    };
  }

  getMenuItemsForNode(node: LexicalNode): DraggableBlockMenuItem[] {
    const nodeType = node.getType();
    const items: DraggableBlockMenuItem[] = [];

    this.menuItems.forEach(item => {
      // Check if this menu item applies to this node type
      if (item.nodeTypes.includes(nodeType) || item.nodeTypes.includes('*')) {
        // Check visibility if function provided
        if (!item.isVisible || item.isVisible(node)) {
          items.push(item);
        }
      }
    });

    // Sort by order (if specified) then by label
    return items.sort((a, b) => {
      if (a.order !== undefined && b.order !== undefined) {
        return a.order - b.order;
      }
      if (a.order !== undefined) return -1;
      if (b.order !== undefined) return 1;
      return a.label.localeCompare(b.label);
    });
  }

  addListener(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notifyListeners(): void {
    this.listeners.forEach(listener => listener());
  }

  clear(): void {
    this.menuItems.clear();
    this.notifyListeners();
  }
}

export const draggableBlockMenuRegistry = DraggableBlockMenuRegistry.getInstance();