/**
 * MockupProjectEditor - Main editor for .mockupproject files.
 *
 * Integrates with Nimbalyst's EditorHost via useEditorLifecycle.
 * Content state lives in a Zustand store (same pattern as DataModelLM).
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { MockupProjectCanvas, type MockupProjectCanvasRef } from './MockupProjectCanvas';
import { createMockupProjectStore, type MockupProjectStoreApi } from '../store/projectStore';
import { createEmptyProject, type MockupProjectFile } from '../types/project';
import {
  useEditorLifecycle,
  useCollaborativeEditor,
  type EditorHostProps,
} from '@nimbalyst/extension-sdk';
import { getFilesystem } from '../index';
import { type MockupTheme } from '../utils/themeEngine';
import { MockupProjectBinding } from '../collab/mockupProjectBinding';
import {
  isMockupProjectYDocEmpty,
  seedMockupProjectYDoc,
} from '../collab/seed';

export function MockupProjectEditor({ host }: EditorHostProps) {
  // Create a store instance per editor
  const storeRef = useRef<MockupProjectStoreApi | null>(null);
  const canvasRef = useRef<MockupProjectCanvasRef>(null);

  if (!storeRef.current) {
    storeRef.current = createMockupProjectStore();
  }
  const store = storeRef.current;

  // Track HTML content for mockup previews
  const [mockupContents, setMockupContents] = useState<Map<string, string>>(() => new Map());

  // Load mockup HTML files for preview and reload when mockup list changes
  useEffect(() => {
    const filesystem = getFilesystem();
    let cancelled = false;

    async function loadMockupContents() {
      const mockups = store.getState().mockups;
      const newContents = new Map<string, string>();

      await Promise.all(
        mockups.map(async (mockup) => {
          try {
            const html = await filesystem.readFile(mockup.path);
            if (!cancelled) {
              newContents.set(mockup.path, html);
            }
          } catch (err) {
            // File may not exist yet
            console.warn('[MockupProject] Could not load:', mockup.path, err);
          }
        })
      );

      if (!cancelled) {
        setMockupContents(newContents);
      }
    }

    loadMockupContents();

    // Reload when store changes (new screens added, etc.)
    const unsubscribe = store.subscribe(() => {
      loadMockupContents();
    });

    // Also poll for external file changes (AI edits, etc.) every 3 seconds
    const interval = setInterval(loadMockupContents, 3000);

    return () => {
      cancelled = true;
      unsubscribe();
      clearInterval(interval);
    };
  }, [store]);

  // Inline "Add Screen" input state
  const [isAddingScreen, setIsAddingScreen] = useState(false);
  const [newScreenName, setNewScreenName] = useState('');
  const addScreenInputRef = useRef<HTMLInputElement>(null);

  // Theme state for mockup previews
  const [mockupTheme, setMockupTheme] = useState<MockupTheme>('dark');

  // Open a mockup file in a new editor tab
  const handleOpenMockup = useCallback((path: string) => {
    const workspacePath = (window as any).__workspacePath;
    if (!workspacePath) {
      console.error('[MockupProject] __workspacePath not set - cannot open file');
      return;
    }
    // Resolve relative paths against workspace root (FileOpener needs absolute paths)
    const absolutePath = path.startsWith('/') ? path : `${workspacePath}/${path}`;

    // Store origin so MockupEditor can show a back-link to this project
    const origins: Record<string, string> = (window as any).__mockupProjectOrigin || {};
    origins[absolutePath] = host.filePath;
    (window as any).__mockupProjectOrigin = origins;

    (window as any).electronAPI?.invoke('workspace:open-file', {
      workspacePath,
      filePath: absolutePath,
    }).catch((err: Error) => {
      console.error('[MockupProject] Failed to open mockup:', err);
    });
  }, [host.filePath]);

  // useEditorLifecycle handles load/save/echo detection
  const { markDirty, isLoading, error, theme } = useEditorLifecycle<MockupProjectFile>(host, {
    parse: (raw: string): MockupProjectFile => {
      if (!raw) return createEmptyProject();
      try {
        return JSON.parse(raw) as MockupProjectFile;
      } catch {
        return createEmptyProject();
      }
    },

    serialize: (data: MockupProjectFile): string => {
      return JSON.stringify(data, null, 2);
    },

    applyContent: (data: MockupProjectFile) => {
      // In collab mode the binding owns the store; createBinding projects
      // the live Y.Doc into the store on bind. host.loadContent() returns
      // only the share-flow seed (or '' parsed to an empty project for a
      // recipient), so loading it here would clobber the already-synced
      // store state. The binding's flushStoreToYDoc would then echo that
      // empty state back into Y.Maps -- last-write-wins on meta keys
      // resets the shared project name / viewport to defaults.
      if (host.collaboration) return;
      store.getState().loadFromFile(data);
      store.getState().markClean();
    },

    getCurrentContent: (): MockupProjectFile => {
      return store.getState().toFileData();
    },

    onLoaded: () => {
      setTimeout(() => {
        store.getState().markInitialLoadComplete();
      }, 100);
    },
  });

  // Wire dirty tracking
  useEffect(() => {
    store.getState().setCallbacks({
      onDirtyChange: (isDirty) => {
        if (isDirty) markDirty();
      },
    });
  }, [store, markDirty]);

  // ---- Collaborative wiring (no-op when host.collaboration is undefined) ----
  // Keyed entities + meta map (see mockupProjectBinding.ts). The binding
  // owns the Zustand-store <-> Y.Doc bridge; in collab mode store mutations
  // get reflected into Y.Maps and remote Y.Map changes get projected back
  // into the store.
  const collabProjectBindingRef = useRef<MockupProjectBinding | null>(null);
  useCollaborativeEditor(host, {
    isEmpty: isMockupProjectYDocEmpty,
    initializeFromContent: seedMockupProjectYDoc,
    createBinding: ({ yDoc, awareness }) => {
      const binding = new MockupProjectBinding(
        yDoc,
        store,
        { enableUndoManager: true },
        awareness,
      );
      collabProjectBindingRef.current = binding;
      return {
        destroy: () => {
          binding.destroy();
          collabProjectBindingRef.current = null;
        },
      };
    },
  });

  // Route Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z through the Y.UndoManager when
  // collab is active. In local-only mode this listener is a no-op because
  // collabProjectBindingRef stays null.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const binding = collabProjectBindingRef.current;
      if (!binding?.undoManager) return;
      const lower = event.key?.toLowerCase();
      if (!lower || lower !== 'z') return;
      if (!(event.ctrlKey || event.metaKey)) return;
      // Let inputs handle their own undo
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (event.shiftKey) {
        binding.redo();
      } else {
        binding.undo();
      }
    };
    window.addEventListener('keydown', handler, { capture: true });
    return () => window.removeEventListener('keydown', handler, { capture: true });
  }, []);

  // Force re-render on store changes
  const [, forceUpdate] = useState(0);
  useEffect(() => {
    const unsubscribe = store.subscribe(() => {
      forceUpdate((n) => n + 1);
    });
    return unsubscribe;
  }, [store]);

  // Focus input when add screen mode is activated
  useEffect(() => {
    if (isAddingScreen) {
      addScreenInputRef.current?.focus();
    }
  }, [isAddingScreen]);

  // Create the mockup file and add it to the project
  const commitAddScreen = useCallback(async (screenName: string) => {
    if (!screenName.trim()) {
      setIsAddingScreen(false);
      setNewScreenName('');
      return;
    }

    const slug = screenName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const projectDir = host.filePath.substring(0, host.filePath.lastIndexOf('/'));
    const mockupPath = `${projectDir}/${slug}.mockup.html`;

    const defaultContent = `<!DOCTYPE html>
<html>
<head>
  <style>
    body {
      font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      margin: 0;
      padding: 20px;
      background: var(--mockup-bg);
      color: var(--mockup-text);
    }
  </style>
</head>
<body>
  <h1>${screenName.trim()}</h1>
  <p>Start designing this screen.</p>
</body>
</html>`;

    try {
      await getFilesystem().writeFile(mockupPath, defaultContent);
    } catch (err) {
      console.error('[MockupProject] Failed to create mockup file:', err);
      setIsAddingScreen(false);
      setNewScreenName('');
      return;
    }

    const count = store.getState().mockups.length;
    store.getState().addMockup({
      path: mockupPath,
      label: screenName.trim(),
      position: { x: 100 + (count % 3) * 500, y: 100 + Math.floor(count / 3) * 400 },
    });

    setIsAddingScreen(false);
    setNewScreenName('');
  }, [store, host.filePath]);

  // Push selected screen context to the chat via EditorHost
  useEffect(() => {
    const unsubscribe = store.subscribe(() => {
      const s = store.getState();
      const selectedId = s.selectedMockupId;
      if (selectedId) {
        const mockup = s.mockups.find((m) => m.id === selectedId);
        if (mockup) {
          // Build description with connections
          const outgoing = s.connections.filter((c) => c.fromMockupId === selectedId);
          const incoming = s.connections.filter((c) => c.toMockupId === selectedId);
          let desc = `Selected screen "${mockup.label}" (${mockup.path}) in mockup project "${s.name}".`;
          if (outgoing.length > 0) {
            const targets = outgoing.map((c) => {
              const target = s.mockups.find((m) => m.id === c.toMockupId);
              return target ? `${target.label} (${c.label || 'link'})` : c.toMockupId;
            });
            desc += `\nNavigates to: ${targets.join(', ')}`;
          }
          if (incoming.length > 0) {
            const sources = incoming.map((c) => {
              const source = s.mockups.find((m) => m.id === c.fromMockupId);
              return source ? `${source.label} (${c.label || 'link'})` : c.fromMockupId;
            });
            desc += `\nNavigated from: ${sources.join(', ')}`;
          }
          // List all screens in the project for full context
          const allScreens = s.mockups.map((m) => `${m.label} (${m.path})`).join(', ');
          desc += `\nAll screens in project: ${allScreens}`;

          host.setEditorContext({
            label: `Screen: ${mockup.label}`,
            description: desc,
          });
        }
      } else {
        // Nothing selected - still provide project-level context
        const s2 = store.getState();
        if (s2.mockups.length > 0) {
          const allScreens = s2.mockups.map((m) => `${m.label} (${m.path})`).join(', ');
          host.setEditorContext({
            label: `Project: ${s2.name}`,
            description: `Mockup project "${s2.name}" with ${s2.mockups.length} screens: ${allScreens}`,
          });
        } else {
          host.setEditorContext(null);
        }
      }
    });
    // Fire once on mount to set initial context
    const s = store.getState();
    if (s.mockups.length > 0) {
      const allScreens = s.mockups.map((m) => `${m.label} (${m.path})`).join(', ');
      host.setEditorContext({
        label: `Project: ${s.name}`,
        description: `Mockup project "${s.name}" with ${s.mockups.length} screens: ${allScreens}`,
      });
    }
    return unsubscribe;
  }, [store, host]);

  const handleStartAddScreen = useCallback(() => {
    setIsAddingScreen(true);
    setNewScreenName('');
  }, []);

  // Handle drop on empty state (before canvas is shown)
  const handleEmptyStateDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    const filePath = event.dataTransfer.getData('text/plain');
    if (!filePath || !filePath.endsWith('.mockup.html')) return;

    const existingPaths = new Set(store.getState().mockups.map((m) => m.path));
    if (existingPaths.has(filePath)) return;

    const fileName = filePath.split('/').pop() || filePath;
    const label = fileName
      .replace('.mockup.html', '')
      .replace(/-/g, ' ')
      .replace(/\b\w/g, (c: string) => c.toUpperCase());

    const count = store.getState().mockups.length;
    store.getState().addMockup({
      path: filePath,
      label,
      position: { x: 100 + (count % 3) * 500, y: 100 + Math.floor(count / 3) * 400 },
    });
  }, [store]);

  const handleEmptyStateDragOver = useCallback((event: React.DragEvent) => {
    if (event.dataTransfer.types.includes('text/plain')) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    }
  }, []);

  const handleAutoLayout = useCallback(() => {
    store.getState().autoLayout();
  }, [store]);

  const handleDeleteSelected = useCallback(() => {
    const state = store.getState();
    if (state.selectedMockupId) {
      store.getState().deleteMockup(state.selectedMockupId);
    } else if (state.selectedConnectionId) {
      store.getState().deleteConnection(state.selectedConnectionId);
    }
  }, [store]);

  if (isLoading) {
    return (
      <div style={{ padding: 20, color: 'var(--nim-text-muted)' }}>
        Loading project...
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: 20, color: 'var(--nim-error)' }}>
        Failed to load: {error.message}
      </div>
    );
  }

  const state = store.getState();

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: 'var(--nim-bg)',
        color: 'var(--nim-text)',
      }}
      data-theme={theme}
    >
      {/* Toolbar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 12px',
          borderBottom: '1px solid var(--nim-border)',
          background: 'var(--nim-bg-secondary)',
          fontSize: 13,
          flexShrink: 0,
        }}
      >
        <span style={{ fontWeight: 600, marginRight: 8 }}>
          {state.name}
        </span>
        <span style={{ color: 'var(--nim-text-faint)', fontSize: 12 }}>
          {state.mockups.length} mockup{state.mockups.length !== 1 ? 's' : ''}
        </span>

        {/* Theme selector for previews */}
        <button
          onClick={() => setMockupTheme((prev) => (prev === 'dark' ? 'light' : 'dark'))}
          style={{
            padding: '3px 6px',
            fontSize: 11,
            background: 'var(--nim-bg)',
            color: 'var(--nim-text)',
            border: '1px solid var(--nim-border)',
            borderRadius: 4,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
          }}
          title={mockupTheme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        >
          {mockupTheme === 'dark' ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="5" />
              <line x1="12" y1="1" x2="12" y2="3" />
              <line x1="12" y1="21" x2="12" y2="23" />
              <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
              <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
              <line x1="1" y1="12" x2="3" y2="12" />
              <line x1="21" y1="12" x2="23" y2="12" />
              <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
              <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
            </svg>
          )}
        </button>

        <div style={{ flex: 1 }} />

        {/* Inline add screen input */}
        {isAddingScreen ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <input
              ref={addScreenInputRef}
              type="text"
              value={newScreenName}
              onChange={(e) => setNewScreenName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitAddScreen(newScreenName);
                if (e.key === 'Escape') { setIsAddingScreen(false); setNewScreenName(''); }
              }}
              onBlur={() => {
                if (newScreenName.trim()) {
                  commitAddScreen(newScreenName);
                } else {
                  setIsAddingScreen(false);
                }
              }}
              placeholder="Screen name..."
              style={{
                padding: '4px 8px',
                fontSize: 12,
                background: 'var(--nim-bg)',
                color: 'var(--nim-text)',
                border: '1px solid var(--nim-primary)',
                borderRadius: 4,
                outline: 'none',
                width: 180,
              }}
            />
          </div>
        ) : (
          <button
            onClick={handleStartAddScreen}
            style={{
              padding: '4px 10px',
              fontSize: 12,
              background: 'var(--nim-primary)',
              color: 'var(--nim-on-primary)',
              border: '1px solid var(--nim-primary)',
              borderRadius: 4,
              cursor: 'pointer',
              fontWeight: 500,
            }}
            title="Add a new mockup screen to this project"
          >
            + Add Screen
          </button>
        )}

        <button
          onClick={handleAutoLayout}
          style={{
            padding: '4px 10px',
            fontSize: 12,
            background: 'var(--nim-bg-tertiary)',
            color: 'var(--nim-text)',
            border: '1px solid var(--nim-border)',
            borderRadius: 4,
            cursor: 'pointer',
          }}
          title="Auto-arrange mockups on canvas"
        >
          Auto Layout
        </button>
        <button
          onClick={handleDeleteSelected}
          disabled={!state.selectedMockupId && !state.selectedConnectionId}
          style={{
            padding: '4px 10px',
            fontSize: 12,
            background: state.selectedMockupId || state.selectedConnectionId ? 'var(--nim-bg-tertiary)' : 'var(--nim-bg-secondary)',
            color: state.selectedMockupId || state.selectedConnectionId ? 'var(--nim-error)' : 'var(--nim-text-disabled)',
            border: '1px solid var(--nim-border)',
            borderRadius: 4,
            cursor: state.selectedMockupId || state.selectedConnectionId ? 'pointer' : 'default',
          }}
          title="Delete selected item"
        >
          Delete
        </button>
      </div>

      {/* Canvas */}
      <div style={{ flex: 1, position: 'relative' }}>
        {state.mockups.length === 0 && !isAddingScreen ? (
          <div
            onDrop={handleEmptyStateDrop}
            onDragOver={handleEmptyStateDragOver}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              color: 'var(--nim-text-faint)',
              gap: 16,
            }}
          >
            <div style={{ fontSize: 16 }}>No screens yet</div>
            <button
              onClick={handleStartAddScreen}
              style={{
                padding: '10px 24px',
                fontSize: 14,
                background: 'var(--nim-primary)',
                color: '#fff',
                border: 'none',
                borderRadius: 6,
                cursor: 'pointer',
                fontWeight: 500,
              }}
            >
              + Add Screen
            </button>
            <div style={{ fontSize: 12, color: 'var(--nim-text-disabled)', textAlign: 'center', lineHeight: 1.5 }}>
              Or drag .mockup.html files from the file tree onto the canvas
            </div>
          </div>
        ) : (
          <ReactFlowProvider>
            <MockupProjectCanvas
              ref={canvasRef}
              store={store}
              mockupContents={mockupContents}
              onOpenMockup={handleOpenMockup}
              mockupTheme={mockupTheme}
            />
          </ReactFlowProvider>
        )}
      </div>
    </div>
  );
}
