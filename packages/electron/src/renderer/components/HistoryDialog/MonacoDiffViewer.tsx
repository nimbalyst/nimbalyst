import React, { useRef, useEffect } from 'react';
import * as monaco from 'monaco-editor';
import { getMonacoLanguage } from '@nimbalyst/runtime';

interface MonacoDiffViewerProps {
  oldContent: string;
  newContent: string;
  filePath: string;
  theme?: string;
  /**
   * Exact Monaco theme name to apply (e.g. from `getMonacoTheme(...)`), so the
   * diff matches the app's active editor theme — including custom/extension
   * themes. When omitted, falls back to the `theme` light/dark mapping.
   */
  monacoThemeName?: string;
  options?: monaco.editor.IDiffEditorConstructionOptions;
  fitHeightToContent?: boolean;
  onDiffReady?: () => void;
}

export function MonacoDiffViewer({
  oldContent,
  newContent,
  filePath,
  theme = 'light',
  monacoThemeName,
  options,
  fitHeightToContent = false,
  onDiffReady,
}: MonacoDiffViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const diffEditorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const onDiffReadyRef = useRef(onDiffReady);

  useEffect(() => {
    onDiffReadyRef.current = onDiffReady;
  }, [onDiffReady]);

  useEffect(() => {
    if (!containerRef.current) return;

    let disposed = false;
    const localContainer = containerRef.current;
    const cleanupDisposables: monaco.IDisposable[] = [];

    // Prefer an explicit Monaco theme name (matches the app editor); else map.
    const monacoTheme = monacoThemeName ?? (theme === 'light' ? 'vs' : 'vs-dark');

    // Detect language from file extension
    const language = getMonacoLanguage(filePath);

    // Create models for original and modified content
    const originalModel = monaco.editor.createModel(oldContent, language);
    const modifiedModel = monaco.editor.createModel(newContent, language);

    // Create diff editor
    const diffEditor = monaco.editor.createDiffEditor(containerRef.current, {
      theme: monacoTheme,
      readOnly: true,
      renderSideBySide: true,
      scrollBeyondLastLine: false,
      minimap: { enabled: false },
      lineNumbers: 'on',
      glyphMargin: false,
      folding: false,
      automaticLayout: true,
      scrollbar: {
        vertical: 'visible',
        horizontal: 'visible',
        useShadows: false,
        verticalScrollbarSize: 10,
        horizontalScrollbarSize: 10
      },
      // Disable diff computation options that might cause issues
      ignoreTrimWhitespace: false,
      renderIndicators: true,
      enableSplitViewResizing: false,
      // Silently handle unusual line terminators (U+2028, U+2029)
      unusualLineTerminators: 'auto',
      ...options,
    });

    diffEditorRef.current = diffEditor;

    // Set the models after a brief delay to ensure editor is ready
    requestAnimationFrame(() => {
      if (!disposed) {
        try {
          let reportedReady = false;
          const reportReady = () => {
            if (reportedReady) return;
            reportedReady = true;
            onDiffReadyRef.current?.();
          };

          const readyDisposable = diffEditor.onDidUpdateDiff(() => {
            reportReady();
            readyDisposable.dispose();
          });

          diffEditor.setModel({
            original: originalModel,
            modified: modifiedModel
          });
          if (fitHeightToContent) {
            const syncHeight = () => {
              if (disposed || !localContainer?.isConnected) return;
              const modifiedHeight = diffEditor.getModifiedEditor().getContentHeight();
              const originalHeight = diffEditor.getOriginalEditor().getContentHeight();
              localContainer.style.height = `${Math.max(modifiedHeight, originalHeight, 120)}px`;
              diffEditor.layout();
            };

            syncHeight();
            cleanupDisposables.push(
              diffEditor.getModifiedEditor().onDidContentSizeChange(syncHeight),
            );
            cleanupDisposables.push(
              diffEditor.getOriginalEditor().onDidContentSizeChange(syncHeight),
            );
          }
        } catch (error) {
          console.error('[MonacoDiffViewer] Failed to set model:', error);
        }
      }
    });

    // Cleanup on unmount - dispose in correct order
    return () => {
      disposed = true;
      for (const disposable of cleanupDisposables) {
        try {
          disposable.dispose();
        } catch (error) {
          console.error('[MonacoDiffViewer] Error disposing listener:', error);
        }
      }

      try {
        // First clear the model from the editor
        if (diffEditor) {
          diffEditor.setModel(null);
          diffEditor.dispose();
        }
      } catch (error) {
        console.error('[MonacoDiffViewer] Error disposing editor:', error);
      }

      // Finally dispose the models
      try {
        originalModel.dispose();
        modifiedModel.dispose();
      } catch (error) {
        console.error('[MonacoDiffViewer] Error disposing models:', error);
      }
    };
  }, [oldContent, newContent, filePath, theme, monacoThemeName]);

  return (
    <div
      className={`monaco-diff-viewer flex flex-col w-full overflow-hidden ${fitHeightToContent ? '' : 'h-full'}`}
    >
      <div
        ref={containerRef}
        className={`monaco-diff-container overflow-hidden min-h-0 ${fitHeightToContent ? '' : 'flex-1'}`}
      />
    </div>
  );
}
