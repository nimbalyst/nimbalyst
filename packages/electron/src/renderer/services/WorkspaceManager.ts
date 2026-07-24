/**
 * WorkspaceManager - Service for managing workspace state
 * Extracted from App.tsx as part of Phase 2 refactoring
 */

export interface FileTreeItem {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileTreeItem[];
}

interface WorkspaceState {
  workspaceMode: boolean;
  workspacePath: string | null;
  workspaceName: string | null;
  fileTree: FileTreeItem[];
  currentFilePath: string | null;
}

type WorkspaceListener = (state: WorkspaceState) => void;

class WorkspaceManager {
  private state: WorkspaceState = {
    workspaceMode: false,
    workspacePath: null,
    workspaceName: null,
    fileTree: [],
    currentFilePath: null,
  };

  private listeners: Set<WorkspaceListener> = new Set();

  get isOpen(): boolean {
    return this.state.workspaceMode;
  }

  get path(): string | null {
    return this.state.workspacePath;
  }

  get name(): string | null {
    return this.state.workspaceName;
  }

  get fileTree(): FileTreeItem[] {
    return this.state.fileTree;
  }

  get currentFilePath(): string | null {
    return this.state.currentFilePath;
  }

  subscribe(listener: WorkspaceListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    this.listeners.forEach(listener => listener(this.state));
  }

  openWorkspace(path: string, name: string): void {
    this.state = {
      ...this.state,
      workspaceMode: true,
      workspacePath: path,
      workspaceName: name,
    };
    this.notify();
  }

  closeWorkspace(): void {
    this.state = {
      workspaceMode: false,
      workspacePath: null,
      workspaceName: null,
      fileTree: [],
      currentFilePath: null,
    };
    this.notify();
  }

  setFileTree(tree: FileTreeItem[]): void {
    this.state = {
      ...this.state,
      fileTree: tree,
    };
    this.notify();
  }

  setCurrentFile(path: string | null): void {
    this.state = {
      ...this.state,
      currentFilePath: path,
    };
    this.notify();
  }

  loadFromState(state: Partial<WorkspaceState>): void {
    this.state = {
      ...this.state,
      ...state,
    };
    this.notify();
  }

  refreshFileTree(): void {
    // Trigger a refresh by notifying listeners
    this.notify();
  }
}

// Singleton instance
export const workspaceManager = new WorkspaceManager();