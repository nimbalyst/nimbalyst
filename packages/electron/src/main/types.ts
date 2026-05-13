export interface TabState {
    id: string;                  // Unique tab identifier
    filePath: string;            // Full file path
    fileName: string;            // Display name
    content?: string;            // Cached content (for inactive tabs)
    isDirty: boolean;            // Unsaved changes
    scrollPosition?: number;     // Preserve scroll position
    cursorPosition?: {          // Preserve cursor position
        line: number;
        column: number;
    };
    editorState?: any;          // Serialized Lexical state
    lastSaved?: Date;           // Last save timestamp
    isPinned?: boolean;         // Pinned tabs don't auto-close
}

export interface WindowState {
    mode: 'document' | 'workspace' | 'agentic-coding';
    filePath: string | null;
    /**
     * The window's primary / create-time workspace path. Kept stable for
     * legacy code that infers context from the window. When the user is in
     * multi-project rail mode and switches projects, the visible project is
     * tracked separately via `activeWorkspacePath`.
     */
    workspacePath: string | null;
    /**
     * The workspace currently visible in this window. Defaults to
     * `workspacePath` when the rail is off. Updated by
     * `workspace:set-active` when the user clicks a different project in
     * the rail.
     */
    activeWorkspacePath?: string | null;
    /**
     * Additional workspace paths kept warm in this window (the rail's
     * inactive projects). Each path here gets its own DocumentService /
     * FileSystemService / WorkspaceEventBus subscription so file watchers
     * and document caches stay alive even when the project is hidden.
     */
    additionalWorkspacePaths?: string[];
    documentEdited: boolean;

    // Tab management (optional for backward compatibility)
    tabs?: TabState[];
    activeTabId?: string;
    tabsEnabled?: boolean;

    // Content mode system (Phase 2 - mode preservation)
    contentMode?: 'files' | 'agent' | 'plan'; // Active content mode in workspace
}

export interface RecentItem {
    path: string;
    name: string;
    timestamp: number;
}

export interface SessionWindow {
    mode: 'document' | 'workspace' | 'agentic-coding';
    filePath?: string;
    workspacePath?: string;
    bounds: {
        x: number;
        y: number;
        width: number;
        height: number;
    };
    focusOrder?: number; // Track window focus order (higher = more recently focused)
    devToolsOpen?: boolean; // Track if developer tools are open
}

export interface SessionState {
    windows: SessionWindow[];
    lastUpdated: number;
}

export interface FileTreeItem {
    name: string;
    type: 'file' | 'directory';
    path: string;
    children?: FileTreeItem[];
    truncated?: number; // Number of items hidden when directory was too large
}