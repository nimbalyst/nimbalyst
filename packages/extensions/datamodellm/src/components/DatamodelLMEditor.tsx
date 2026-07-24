/**
 * DatamodelLM Editor
 *
 * The main editor component that integrates with Nimbalyst's custom editor system.
 * Uses useEditorLifecycle for load/save/echo detection lifecycle.
 * Content state lives in a Zustand store, not React state.
 */

import { useEffect, useRef, useCallback, useMemo, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { DataModelCanvas, type DataModelCanvasRef } from './DataModelCanvas';
import { DataModelToolbar } from './DataModelToolbar';
import { createDataModelStore, type DataModelStoreApi } from '../store';
import { createEmptyDataModel, type DataModelFile } from '../types';
import { parsePrismaSchema, serializeToPrismaSchema } from '../prismaParser';
import { captureDataModelCanvas, copyScreenshotToClipboard } from '../utils/screenshotUtils';
import {
  useEditorLifecycle,
  useCollaborativeEditor,
  type EditorHostProps,
} from '@nimbalyst/extension-sdk';
import { DataModelBinding } from '../collab/datamodelBinding';
import { isDataModelYDocEmpty, seedDataModelYDoc } from '../collab/seed';
import { buildEntitySelectionContextItem, buildRelationshipSelectionContextItem } from '../selectionContext';

export function DatamodelLMEditor({ host }: EditorHostProps) {
  const { filePath } = host;

  // Reactive read-only state. In read-only mode (inline embeds, share
  // viewer) we hide the toolbar so the schema graph reads cleanly.
  // React Flow's pan / zoom stays available either way.
  const [readOnly, setReadOnly] = useState<boolean>(host.readOnly ?? false);
  useEffect(() => {
    setReadOnly(host.readOnly ?? false);
    return host.onReadOnlyChanged?.((next) => {
      setReadOnly(next);
    });
  }, [host]);

  // Create a store instance for this editor (content lives here, not React state)
  const storeRef = useRef<DataModelStoreApi | null>(null);
  const canvasRef = useRef<DataModelCanvasRef>(null);
  // The editor's root DOM element -- used by the collab binding to install
  // its capture-phase undo/redo keyboard handler. Not needed in local-only
  // mode (the binding never runs).
  const rootElRef = useRef<HTMLDivElement | null>(null);

  if (!storeRef.current) {
    storeRef.current = createDataModelStore();
  }
  const store = storeRef.current;

  // useEditorLifecycle handles: loading, saving, echo detection, file changes, theme
  const { markDirty, isLoading, error, theme } = useEditorLifecycle<DataModelFile>(host, {
    parse: (raw: string): DataModelFile => {
      if (!raw) return createEmptyDataModel();
      try {
        return parsePrismaSchema(raw);
      } catch (err) {
        // console.error('[DatamodelLM] Failed to parse Prisma schema:', err);
        return createEmptyDataModel();
      }
    },

    serialize: (data: DataModelFile): string => {
      return serializeToPrismaSchema(data);
    },

    // Push: load data into the Zustand store
    applyContent: (data: DataModelFile) => {
      // In collab mode the binding owns the store content: it loads the
      // authoritative Y.Doc state on mount and diffs store edits back into
      // the Y.Doc. A lifecycle load here (reopen of a shared doc parses ''
      // to an empty model) would replace the store and the store-diff would
      // push entity deletes into the shared room. Same rule as MockupEditor.
      // NIM-1529.
      if (host.collaboration) return;
      store.getState().loadFromFile(data);
      store.getState().markClean();
    },

    // Pull: get current data from the Zustand store
    getCurrentContent: (): DataModelFile => {
      return store.getState().toFileData();
    },

    onLoaded: () => {
      // Give React Flow time to complete fitView before tracking dirty changes
      setTimeout(() => {
        store.getState().markInitialLoadComplete();
      }, 100);
    },
  });

  // Set up callbacks for dirty tracking via markDirty from the lifecycle hook
  useEffect(() => {
    store.getState().setCallbacks({
      onDirtyChange: (isDirty) => {
        if (isDirty) markDirty();
      },
    });
  }, [store, markDirty]);

  // Subscribe to store changes and force re-render
  const [, forceUpdate] = useState(0);
  useEffect(() => {
    const unsubscribe = store.subscribe(() => {
      forceUpdate((n) => n + 1);
    });
    return unsubscribe;
  }, [store]);

  const selectionState = store.getState();
  const editorContextItem = useMemo(() => {
    if (selectionState.selectedEntityId) {
      const entity = selectionState.entities.find((candidate) => candidate.id === selectionState.selectedEntityId);
      return entity ? buildEntitySelectionContextItem(entity, selectionState.database) : null;
    }
    if (selectionState.selectedRelationshipId) {
      const relationship = selectionState.relationships.find(
        (candidate) => candidate.id === selectionState.selectedRelationshipId,
      );
      return relationship ? buildRelationshipSelectionContextItem(relationship, selectionState.database) : null;
    }
    return null;
  }, [selectionState.database, selectionState.entities, selectionState.relationships, selectionState.selectedEntityId, selectionState.selectedRelationshipId]);

  useEffect(() => {
    host.setEditorContextItems(editorContextItem ? [editorContextItem] : null);
  }, [editorContextItem, host]);

  useEffect(() => () => host.setEditorContextItems(null), [host]);

  // Register store for AI tool access via the central registry
  useEffect(() => {
    host.registerEditorAPI(store);
    return () => {
      host.registerEditorAPI(null);
    };
  }, [filePath, store]);

  // ---- Collaborative wiring (no-op when host.collaboration is undefined) ---
  // The binding takes the Y.Doc as authoritative on mount, replacing the
  // local store's nanoid ids with the deterministic stable ids the seed
  // wrote. Subsequent local edits diff into Y.Doc; remote Y.Doc edits apply
  // back through the store's incremental actions (preserving selection).
  // See packages/extensions/datamodellm/src/collab/datamodelBinding.ts.
  const { isCollaborative, status: collabStatus } = useCollaborativeEditor(host, {
    isEmpty: isDataModelYDocEmpty,
    initializeFromContent: seedDataModelYDoc,
    createBinding: ({ yDoc, awareness }) => {
      const binding = new DataModelBinding(yDoc, store, awareness, {
        rootEl: rootElRef.current,
      });
      return { destroy: () => binding.destroy() };
    },
  });

  // Handle screenshot capture
  const handleScreenshot = useCallback(async () => {
    const canvasElement = canvasRef.current?.getCanvasElement();
    if (!canvasElement) return;

    try {
      const base64Data = await captureDataModelCanvas(canvasElement);
      await copyScreenshotToClipboard(base64Data);
      // console.log('[DatamodelLM] Screenshot copied to clipboard');
    } catch (err) {
      // console.error('[DatamodelLM] Failed to capture screenshot:', err);
    }
  }, []);

  if (isLoading) {
    return (
      <div className="datamodel-editor" data-theme={theme}>
        <div className="p-5 text-nim-muted">Loading...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="datamodel-editor" data-theme={theme}>
        <div className="p-5 text-nim-error">
          Failed to load: {error.message}
        </div>
      </div>
    );
  }

  return (
    <div
      className="datamodel-editor"
      data-theme={theme}
      data-read-only={readOnly}
      data-collab-status={isCollaborative ? collabStatus : undefined}
      ref={rootElRef}
    >
      {!readOnly && (
        <DataModelToolbar store={store} onScreenshot={handleScreenshot} host={host} />
      )}
      <ReactFlowProvider>
        <DataModelCanvas ref={canvasRef} store={store} theme={theme} readOnly={readOnly} />
      </ReactFlowProvider>
    </div>
  );
}
