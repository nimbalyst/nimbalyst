# React State Architecture for Editors

**CRITICAL: Do NOT "lift state up" for complex applications.**

The "lift state up" pattern is appropriate for simple React apps but becomes an anti-pattern in IDE-like applications. This codebase explicitly rejects that pattern for editor state.

## State Ownership Principles

### 1. Editors Own Their Content State

- Custom editors (Monaco, RevoGrid, Lexical) own their document content
- Parent only knows "tab X uses editor Y for file Z" - NOT the file contents
- Editor content is NEVER stored in a Map/object in a parent component

### 2. Use Jotai Atoms for Cross-Cutting State

- Theme, preferences (global atoms)
- Tab metadata - dirty, processing (atom families by tab ID)
- Session state - unread, processing (atom families by session ID)
- File tree git status (atom per file/directory)
- **IMPORTANT**: Atoms are updated by centralized IPC listeners, NOT by components directly

### 3. Communication via EditorHost, Not Props

```typescript
// BAD: Controlled editor
<Editor content={content} onChange={setContent} />

// GOOD: Editor owns state, uses host for I/O
<Editor host={editorHost} />
// Editor calls host.loadContent() on mount
// Editor calls host.saveContent() when saving
// Editor calls host.setDirty() on changes
```

### 4. Stateful Editors Cannot Be Re-Rendered

- RevoGrid, Monaco, Lexical manage internal state
- Parent re-renders will break them
- Changes flow through callbacks, not props

## EditorHost Contract

The EditorHost is the primary API for editor-host communication:

```typescript
interface EditorHost {
  // Content loading
  loadContent(): Promise<string>;
  loadBinaryContent(): Promise<Uint8Array>;

  // State reporting
  setDirty(dirty: boolean): void;

  // Save handling
  saveContent(content: string): Promise<void>;
  onSaveRequested(callback: () => Promise<void>): void;

  // File change detection
  onFileChanged(callback: (newContent: string) => void): void;

  // Diff mode support
  onDiffRequested(callback: () => Promise<DiffResult>): void;
  reportDiffResult(result: DiffResult): void;
}
```

## Editor State Atoms

Located in `packages/runtime/src/store/atoms/editors.ts`:

- `editorDirtyAtom` - Per-editor dirty state
- `editorProcessingAtom` - AI processing indicator
- `editorHasUnacceptedChangesAtom` - Pending review state
- `tabIdsAtom` - Tab list per context
- `activeTabIdAtom` - Active tab selection
- `tabMetadataAtom` - Tab metadata (pinned, virtual, custom title/icon)

## Anti-Pattern Recognition

| Anti-Pattern | Problem | Solution |
| --- | --- | --- |
| `Map<string, Content>` in parent | All children re-render on any change | Each editor owns its content |
| `Map<string, Status>` as prop | Reference changes trigger re-render | Use Jotai atom family |
| Polling in render (`hasPendingDiffs()`) | O(n) on every render | Subscribe to atom updates |
| 15 refs to avoid re-renders | Fighting the architecture | Fix state ownership |
| `useState` for cross-component state | Prop drilling or context re-renders | Use Jotai atoms |
| Component subscribes to IPC events | Race conditions, stale closures, memory leaks | Use centralized IPC listeners |
| `isCurrent` flags everywhere | Defensive programming hiding architecture flaw | Isolate state by ID using atom families |

## Key Files

**Editor Implementations:**
- `packages/runtime/src/editors/MarkdownEditor.tsx` - Lexical-based markdown
- `packages/runtime/src/editors/MonacoCodeEditor.tsx` - Monaco code editor
- `packages/runtime/src/editor/Editor.tsx` - Core Lexical editor

**EditorHost:**
- `packages/runtime/src/extensions/editorHost.ts` - Host implementation
- `packages/runtime/src/extensions/useEditorLifecycle.ts` - Lifecycle hook for custom editors
- `packages/extension-sdk/src/types/editor.ts` - Type definitions

**State Atoms:**
- `packages/runtime/src/store/atoms/editors.ts` - Editor state atoms
- `packages/electron/src/renderer/store/atoms/sessionEditors.ts` - Session editor atoms

**TabEditor Infrastructure:**
- `packages/electron/src/renderer/components/TabEditor/` - Tab management
