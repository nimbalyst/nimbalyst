/**
 * DatamodelLM Editor
 *
 * The main editor component that integrates with Nimbalyst's custom editor system.
 * Uses useEditorLifecycle for load/save/echo detection lifecycle.
 * Content state lives in a Zustand store, not React state.
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { DataModelCanvas, type DataModelCanvasRef } from './DataModelCanvas';
import { DataModelToolbar } from './DataModelToolbar';
import { createDataModelStore, type DataModelStoreApi } from '../store';
import { createEmptyDataModel, type DataModelFile } from '../types';
import { parsePrismaSchema, serializeToPrismaSchema } from '../prismaParser';
import { captureDataModelCanvas, copyScreenshotToClipboard } from '../utils/screenshotUtils';
import { useEditorLifecycle, type EditorHostProps } from '@nimbalyst/extension-sdk';

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

  // Register store for AI tool access via the central registry
  useEffect(() => {
    host.registerEditorAPI(store);
    return () => {
      host.registerEditorAPI(null);
    };
  }, [filePath, store]);

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
    <div className="datamodel-editor" data-theme={theme} data-read-only={readOnly}>
      {!readOnly && (
        <DataModelToolbar store={store} onScreenshot={handleScreenshot} host={host} />
      )}
      <ReactFlowProvider>
        <DataModelCanvas ref={canvasRef} store={store} theme={theme} readOnly={readOnly} />
      </ReactFlowProvider>
    </div>
  );
}
