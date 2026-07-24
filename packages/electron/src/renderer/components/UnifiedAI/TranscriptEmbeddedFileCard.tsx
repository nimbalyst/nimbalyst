import React, { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { basename } from 'pathe';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { store } from '@nimbalyst/runtime/store';

import { customEditorRegistry } from '../CustomEditors/registry';
import { fileChangedOnDiskAtomFamily } from '../../store/atoms/fileWatch';
import { useTheme } from '../../hooks/useTheme';
import { createEmbeddedFileHost } from '../EmbedFrame/createEmbeddedFileHost';

const DEFAULT_PREVIEW_HEIGHT = 360;

type ReadFileResult =
  | null
  | { success: true; content: string; isBinary: boolean; detectedEncoding?: string }
  | { success: false; error: string };

async function readFileFromDisk(absolutePath: string): Promise<string> {
  const api = (window as unknown as {
    electronAPI?: {
      readFileContent?: (
        path: string,
        opts?: { binary?: boolean },
      ) => Promise<ReadFileResult>;
    };
  }).electronAPI;
  if (!api?.readFileContent) {
    throw new Error('readFileContent IPC not available');
  }
  const result = await api.readFileContent(absolutePath);
  if (!result) {
    throw new Error(`File not found: ${absolutePath}`);
  }
  if (result.success === false) {
    throw new Error(result.error || `Failed to read ${absolutePath}`);
  }
  return result.content;
}

class TranscriptEmbeddedFileErrorBoundary extends Component<
  { children: ReactNode; filePath: string },
  { hasError: boolean; error: Error | null }
> {
  state = { hasError: false, error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error) {
    console.error('[TranscriptEmbeddedFileCard] Failed to render preview for', this.props.filePath, error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="transcript-embedded-file__error flex items-center gap-2 p-3 text-sm text-[var(--nim-error)]">
          <MaterialSymbol icon="error" size={16} />
          <span>{this.state.error?.message ?? 'Failed to render preview'}</span>
        </div>
      );
    }
    return this.props.children;
  }
}

interface TranscriptEmbeddedFileCardProps {
  filePath: string;
  onOpenFile?: (filePath: string) => void;
  defaultExpanded?: boolean;
}

export const TranscriptEmbeddedFileCard: React.FC<TranscriptEmbeddedFileCardProps> = ({
  filePath,
  onOpenFile,
  defaultExpanded = false,
}) => {
  const { theme } = useTheme();
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  // Click-to-activate gate. Mirrors EmbedFrame's shield: until the user
  // clicks into the preview, a transparent shield swallows pointer +
  // wheel events so scrolling over the embed scrolls the transcript
  // instead of being captured by the embedded editor (e.g. Excalidraw's
  // wheel-zoom, RevoGrid's wheel-scroll). Once active, the shield drops
  // out and the editor receives input directly until the user clicks
  // elsewhere.
  const [isActive, setIsActive] = useState(false);
  const cardRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (defaultExpanded) {
      setIsExpanded(true);
    }
  }, [defaultExpanded, filePath]);

  // Deactivate when collapsed so the next expansion starts in the
  // scroll-passthrough state.
  useEffect(() => {
    if (!isExpanded && isActive) {
      setIsActive(false);
    }
  }, [isExpanded, isActive]);

  // Click-outside listener: when active, any pointerdown outside the card
  // returns it to the inactive (shielded) state.
  useEffect(() => {
    if (!isActive) return;
    const handlePointerDown = (event: PointerEvent) => {
      const root = cardRef.current;
      if (!root) return;
      if (event.target instanceof Node && root.contains(event.target)) return;
      setIsActive(false);
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
    };
  }, [isActive]);

  const registration = useMemo(
    () => customEditorRegistry.findRegistrationForFile(filePath),
    [filePath],
  );
  const isSupportedFile = !!registration?.supportsTranscriptEmbed;

  const themeRef = useRef(theme);
  themeRef.current = theme;
  const themeListeners = useRef(new Set<(theme: string) => void>());
  useEffect(() => {
    themeListeners.current.forEach((cb) => cb(theme));
  }, [theme]);

  const host = useMemo(() => {
    if (!isSupportedFile || !registration) return null;

    return createEmbeddedFileHost({
      embedPath: filePath,
      isActive: false,
      workspaceId: (window as unknown as { __workspacePath?: string }).__workspacePath,
      getTheme: () => themeRef.current,
      subscribeToThemeChanges(cb) {
        themeListeners.current.add(cb);
        return () => {
          themeListeners.current.delete(cb);
        };
      },
      subscribeToFileChanges(path, cb) {
        const atom = fileChangedOnDiskAtomFamily(path);
        return store.sub(atom, () => {
          readFileFromDisk(path)
            .then(cb)
            .catch((error) => {
              console.error('[TranscriptEmbeddedFileCard] Failed to reload preview for', path, error);
            });
        });
      },
      readFile: readFileFromDisk,
      saveFile: async () => {},
      getReadOnly: () => true,
      subscribeToReadOnlyChanges: () => () => {},
      onDirtyChange: () => {},
      subscribeToSaveRequests: () => () => {},
    });
  }, [filePath, isSupportedFile, registration]);

  const handleOpenFile = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    onOpenFile?.(filePath);
  }, [filePath, onOpenFile]);

  const handleShieldClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    event.stopPropagation();
    setIsActive(true);
  }, []);

  const handleShieldDoubleClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    event.stopPropagation();
    onOpenFile?.(filePath);
  }, [filePath, onOpenFile]);

  if (!isSupportedFile) {
    return null;
  }

  const canRenderPreview = isSupportedFile && host != null;
  const ExtensionComponent = registration?.component;
  const editorLabel = registration?.name || 'Rendered file';
  const previewHeight = registration?.transcriptEmbedHeight ?? DEFAULT_PREVIEW_HEIGHT;

  return (
    <div
      ref={cardRef}
      className={`transcript-embedded-file mt-2 rounded-md border bg-[var(--nim-bg)] ${
        isActive
          ? 'border-[color-mix(in_srgb,var(--nim-primary)_45%,var(--nim-border))]'
          : 'border-[var(--nim-border)]'
      }`}
      data-component="transcript-embedded-file"
      data-testid="transcript-embedded-file"
      data-file-path={filePath}
      data-active={isActive ? 'true' : 'false'}
    >
      <div className="transcript-embedded-file__header flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setIsExpanded((prev) => !prev)}
          className="flex min-w-0 flex-1 items-center gap-2 border-none bg-transparent p-0 text-left text-sm text-[var(--nim-text)] cursor-pointer"
          aria-expanded={isExpanded}
        >
          <MaterialSymbol
            icon={isExpanded ? 'expand_more' : 'chevron_right'}
            size={16}
            className="shrink-0 text-[var(--nim-text-faint)]"
          />
          <MaterialSymbol icon="preview" size={16} className="shrink-0 text-[var(--nim-primary)]" />
          <span className="font-medium">{editorLabel}</span>
          <span className="min-w-0 truncate text-xs text-[var(--nim-text-muted)]">
            {basename(filePath)}
          </span>
        </button>
        {onOpenFile && (
          <button
            type="button"
            className="flex h-6 w-6 items-center justify-center rounded border-none bg-transparent p-0 text-[var(--nim-text-faint)] cursor-pointer transition-colors duration-150 hover:bg-[var(--nim-bg-tertiary)] hover:text-[var(--nim-text)]"
            onClick={handleOpenFile}
            title="Open file"
            aria-label="Open file"
          >
            <MaterialSymbol icon="open_in_new" size={14} />
          </button>
        )}
      </div>

      {isExpanded && (
        <div
          className="transcript-embedded-file__body relative isolate border-t border-[var(--nim-border)] bg-[var(--nim-bg-secondary)]"
          style={{ height: `${previewHeight}px` }}
        >
          {!canRenderPreview || !ExtensionComponent || !host ? (
            <div className="transcript-embedded-file__placeholder flex h-full items-center justify-center px-4 text-center text-sm text-[var(--nim-text-muted)]">
              No editor is available to render this file inline.
            </div>
          ) : (
            <TranscriptEmbeddedFileErrorBoundary filePath={filePath}>
              {/* `inert` on the editor wrapper blocks pointer + wheel
                * events even from editor canvases that paint above the
                * shield (e.g. Excalidraw's high-z-index canvas). The
                * shield on top still provides the click-to-activate
                * affordance. */}
              <div
                className="transcript-embedded-file__canvas h-full overflow-hidden"
                {...(isActive ? {} : { inert: '' as unknown as boolean })}
              >
                <React.Suspense
                  fallback={
                    <div className="transcript-embedded-file__loading flex h-full items-center justify-center text-sm text-[var(--nim-text-muted)]">
                      Loading preview...
                    </div>
                  }
                >
                  <ExtensionComponent host={host} />
                </React.Suspense>
              </div>
              {!isActive && (
                <div
                  className="transcript-embedded-file__shield absolute inset-0 z-[2] cursor-pointer bg-transparent"
                  data-testid="transcript-embedded-file-shield"
                  onClick={handleShieldClick}
                  onDoubleClick={handleShieldDoubleClick}
                  aria-hidden="true"
                />
              )}
            </TranscriptEmbeddedFileErrorBoundary>
          )}
        </div>
      )}
    </div>
  );
};
