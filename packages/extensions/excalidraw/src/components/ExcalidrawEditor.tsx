/**
 * Excalidraw Editor
 *
 * Custom editor for .excalidraw files that integrates with Nimbalyst's EditorHost API.
 * Uses useEditorLifecycle for load/save/echo detection lifecycle.
 * Excalidraw library owns all drawing state -- the hook never stores content in React state.
 */

import { useEffect, useRef, useCallback, useState, forwardRef } from 'react';
import { Excalidraw, exportToBlob } from '@excalidraw/excalidraw';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/types/element/types';
import type { ExcalidrawImperativeAPI, AppState, BinaryFiles } from '@excalidraw/excalidraw/types/types';
import {
  useEditorLifecycle,
  useCollaborativeEditor,
  type EditorHostProps,
} from '@nimbalyst/extension-sdk';
import * as Y from 'yjs';
import { ExcalidrawBinding } from '../collab/excalidrawBindings';
import { isExcalidrawYDocEmpty, seedExcalidrawYDoc } from '../collab/seed';
import type { ExcalidrawFile } from '../types';

// Default empty Excalidraw file
function createEmptyFile(bgColor: string): ExcalidrawFile {
  return {
    type: 'excalidraw',
    version: 2,
    source: 'https://excalidraw.com',
    elements: [],
    appState: {
      viewBackgroundColor: bgColor,
      collaborators: new Map(),
    },
    files: {},
  };
}

export const ExcalidrawEditor = forwardRef<any, EditorHostProps>(function ExcalidrawEditor({ host }, ref) {
  const { filePath } = host;

  // Excalidraw only supports 'light' or 'dark'
  const hostThemeInitial = host.theme;
  const themeInitial = (hostThemeInitial === 'dark' || hostThemeInitial === 'crystal-dark') ? 'dark' : 'light';
  const defaultBgRef = useRef(themeInitial === 'dark' ? '#1e1e1e' : '#ffffff');

  // Honor host.readOnly via Excalidraw's `viewModeEnabled` (hides toolbars
  // and disables editing while keeping pan/zoom). Reactive: subscribe to
  // host.onReadOnlyChanged so the embed's View/Edit chrome toggle flips
  // the canvas in place without forcing a remount.
  const [readOnly, setReadOnly] = useState<boolean>(host.readOnly ?? false);
  useEffect(() => {
    setReadOnly(host.readOnly ?? false);
    const unsub = host.onReadOnlyChanged?.((next) => {
      setReadOnly(next);
    });
    return unsub;
  }, [host]);

  // Excalidraw API reference (imperative -- the library owns all state)
  const excalidrawAPIRef = useRef<ExcalidrawImperativeAPI | null>(null);

  // Initial data for Excalidraw (set once on load, then Excalidraw owns it)
  const [initialData, setInitialData] = useState<{
    elements: ExcalidrawElement[];
    appState: Partial<AppState>;
    files: BinaryFiles;
  } | null>(null);

  // Track when we're programmatically updating the scene (to suppress onChange -> dirty)
  const isUpdatingFromExternalRef = useRef(false);

  // Previous state for change detection
  // NOTE: Excalidraw reuses array references (mutates in place), so we track
  // element id -> version instead of array references
  const previousElementVersionsRef = useRef<Map<string, number>>(new Map());
  const previousFilesCountRef = useRef<number>(0);
  const previousAppStateRef = useRef<{
    scrollX: number;
    scrollY: number;
    zoom: number;
    viewBackgroundColor: string;
  } | null>(null);

  // Helper: update version tracking refs from parsed data
  const updateTrackingRefs = useCallback((data: ExcalidrawFile, bgColor: string) => {
    const elements = data.elements as ExcalidrawElement[];
    const files = data.files || {};

    const versionMap = new Map<string, number>();
    for (const el of elements) {
      versionMap.set(el.id, el.version);
    }
    previousElementVersionsRef.current = versionMap;
    previousFilesCountRef.current = Object.keys(files).length;
    previousAppStateRef.current = {
      scrollX: data.appState?.scrollX ?? 0,
      scrollY: data.appState?.scrollY ?? 0,
      zoom: typeof data.appState?.zoom === 'object' ? data.appState.zoom.value : (data.appState?.zoom ?? 1),
      viewBackgroundColor: data.appState?.viewBackgroundColor ?? bgColor,
    };
  }, []);

  // useEditorLifecycle handles: loading, saving, echo detection, file changes, theme
  const { markDirty, isLoading, error, theme: hostTheme } = useEditorLifecycle<ExcalidrawFile>(host, {
    parse: (raw: string): ExcalidrawFile => {
      if (!raw) return createEmptyFile(defaultBgRef.current);
      try {
        return JSON.parse(raw);
      } catch {
        return createEmptyFile(defaultBgRef.current);
      }
    },

    serialize: (data: ExcalidrawFile): string => {
      return JSON.stringify(data, null, 2);
    },

    // Push: called on initial load and external file changes
    applyContent: (data: ExcalidrawFile) => {
      const bgColor = defaultBgRef.current;
      const elements = data.elements as ExcalidrawElement[];
      const files = data.files || {};

      const api = excalidrawAPIRef.current;
      if (api) {
        // External change after initial load -- update via imperative API
        isUpdatingFromExternalRef.current = true;
        try {
          api.updateScene({
            elements,
            appState: data.appState as any,
          });
        } finally {
          queueMicrotask(() => {
            isUpdatingFromExternalRef.current = false;
          });
        }
      } else {
        // Initial load -- set initial data for Excalidraw mount
        setInitialData({
          elements,
          appState: {
            viewBackgroundColor: bgColor,
            collaborators: new Map(),
            ...data.appState,
          },
          files,
        });
      }

      updateTrackingRefs(data, bgColor);
    },

    // Pull: called when host requests a save
    getCurrentContent: (): ExcalidrawFile => {
      const api = excalidrawAPIRef.current;
      if (!api) {
        // console.error('[Excalidraw] Cannot save: API not ready');
        return createEmptyFile(defaultBgRef.current);
      }

      const appState = api.getAppState();
      return {
        type: 'excalidraw',
        version: 2,
        source: 'https://excalidraw.com',
        elements: api.getSceneElements(),
        appState: {
          viewBackgroundColor: appState.viewBackgroundColor,
          scrollX: appState.scrollX,
          scrollY: appState.scrollY,
          zoom: appState.zoom,
        },
        files: api.getFiles(),
      };
    },
  });

  // Excalidraw only supports 'light' or 'dark'
  const theme = (hostTheme === 'dark' || hostTheme === 'crystal-dark') ? 'dark' : 'light';
  defaultBgRef.current = theme === 'dark' ? '#1e1e1e' : '#ffffff';

  // Mark as dirty only when elements actually change (not just view state)
  const onChange = useCallback((
    elements: readonly ExcalidrawElement[],
    appState: AppState,
    files: BinaryFiles,
  ) => {
    if (isUpdatingFromExternalRef.current) return;

    // Check if elements actually changed (version-based comparison)
    const prevVersions = previousElementVersionsRef.current;
    let elementsChanged = elements.length !== prevVersions.size;

    if (!elementsChanged) {
      for (const element of elements) {
        const prevVersion = prevVersions.get(element.id);
        if (prevVersion === undefined || prevVersion !== element.version) {
          elementsChanged = true;
          break;
        }
      }
    }

    // Check files
    const currFilesCount = Object.keys(files).length;
    const filesChanged = currFilesCount !== previousFilesCountRef.current;

    // Check saved appState (scroll, zoom, background)
    const prevAppState = previousAppStateRef.current;
    const zoomValue = typeof appState.zoom === 'object' ? appState.zoom.value : appState.zoom;
    const appStateChanged = prevAppState === null ||
      prevAppState.scrollX !== appState.scrollX ||
      prevAppState.scrollY !== appState.scrollY ||
      prevAppState.zoom !== zoomValue ||
      prevAppState.viewBackgroundColor !== appState.viewBackgroundColor;

    // Update tracking refs
    const newVersions = new Map<string, number>();
    for (const element of elements) {
      newVersions.set(element.id, element.version);
    }
    previousElementVersionsRef.current = newVersions;
    previousFilesCountRef.current = currFilesCount;
    previousAppStateRef.current = {
      scrollX: appState.scrollX,
      scrollY: appState.scrollY,
      zoom: zoomValue,
      viewBackgroundColor: appState.viewBackgroundColor,
    };

    if (elementsChanged || filesChanged || appStateChanged) {
      markDirty();
    }
  }, [markDirty]);

  // ---- Collaborative wiring (no-op when host.collaboration is undefined) ---
  // The binding wraps the imperative Excalidraw API and routes local edits
  // into the shared Y.Doc + remote Y.Doc changes back onto the canvas. The
  // hook runs createBinding ONCE per host, after sync completes and after
  // first-time seeding (if needed).
  const excalidrawDomRef = useRef<HTMLDivElement | null>(null);
  const bindingRef = useRef<ExcalidrawBinding | null>(null);
  const { isCollaborative, status: collabStatus } = useCollaborativeEditor(host, {
    isEmpty: isExcalidrawYDocEmpty,
    initializeFromContent: seedExcalidrawYDoc,
    createBinding: ({ yDoc, awareness }) => {
      const api = excalidrawAPIRef.current;
      if (!api) {
        // Should not happen: Excalidraw's onMount callback fires synchronously
        // and the SDK hook only invokes createBinding after sync completes,
        // which is comfortably after the canvas has mounted. Guard anyway.
        return { destroy: () => {} };
      }
      const undoManager = new Y.UndoManager(yDoc.getArray('elements'));
      const binding = new ExcalidrawBinding(
        yDoc.getArray('elements'),
        yDoc.getMap('assets'),
        api,
        awareness,
        excalidrawDomRef.current
          ? { excalidrawDom: excalidrawDomRef.current, undoManager }
          : undefined,
      );
      bindingRef.current = binding;
      return {
        destroy: () => {
          binding.destroy();
          undoManager.destroy();
          bindingRef.current = null;
        },
      };
    },
  });
  // Forward pointer updates to awareness when in collab mode. Excalidraw's
  // onPointerUpdate fires very frequently; the binding internally throttles
  // through y-protocols / DocumentSyncProvider (~2Hz).
  const onPointerUpdate = useCallback(
    (payload: Parameters<NonNullable<Parameters<typeof Excalidraw>[0]['onPointerUpdate']>>[0]) => {
      bindingRef.current?.onPointerUpdate(payload);
    },
    [],
  );

  // Create a wrapper around the Excalidraw API that adds screenshot export capability.
  // This keeps Excalidraw-specific export logic in the extension rather than the host.
  const createWrappedAPI = useCallback((api: ExcalidrawImperativeAPI) => {
    return Object.create(api, {
      exportToPngBlob: {
        value: async (opts?: { padding?: number; maxWidthOrHeight?: number }) => {
          const elements = api.getSceneElements();
          const appState = api.getAppState();
          const files = api.getFiles();
          return exportToBlob({
            elements,
            appState: { ...appState, exportWithDarkMode: appState.theme === 'dark' },
            files,
            mimeType: 'image/png',
            exportPadding: opts?.padding ?? 20,
            maxWidthOrHeight: opts?.maxWidthOrHeight,
          });
        },
        writable: false,
        enumerable: true,
      },
    });
  }, []);

  // Register editor API for AI tool access via the central registry
  useEffect(() => {
    const api = excalidrawAPIRef.current;
    if (api) {
      host.registerEditorAPI(createWrappedAPI(api));
      return () => {
        host.registerEditorAPI(null);
      };
    }
  }, [filePath, initialData, createWrappedAPI]); // Re-register when initialData changes (means API is set)

  if (isLoading) {
    return (
      <div className="excalidraw-editor w-full h-full flex items-center justify-center" data-theme={theme}>
        <div className="text-nim-muted">Loading diagram...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="excalidraw-editor w-full h-full flex items-center justify-center" data-theme={theme}>
        <div className="text-nim-error">
          Failed to load: {error.message}
        </div>
      </div>
    );
  }

  // Key by theme to force remount when theme changes. `viewModeEnabled`
  // does NOT force remount -- the Excalidraw library accepts it as a live
  // prop, so toggling it from the embed chrome flips toolbars on/off
  // without losing the canvas state.
  return (
    <div
      className="excalidraw-editor w-full h-full"
      data-theme={theme}
      ref={excalidrawDomRef}
      data-collab-status={isCollaborative ? collabStatus : undefined}
    >
      <Excalidraw
        key={theme}
        onChange={onChange}
        onPointerUpdate={isCollaborative ? onPointerUpdate : undefined}
        excalidrawAPI={(api: any) => {
          excalidrawAPIRef.current = api;
          if (api) host.registerEditorAPI(createWrappedAPI(api));
        }}
        initialData={initialData ?? undefined}
        theme={theme}
        viewModeEnabled={readOnly}
      />
    </div>
  );
});
