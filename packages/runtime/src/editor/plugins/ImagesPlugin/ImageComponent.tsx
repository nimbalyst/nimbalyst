/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {
  BaseSelection,
  LexicalCommand,
  LexicalEditor,
  NodeKey,
} from 'lexical';
import type {JSX} from 'react';

import './ImageNode.css';

import {AutoFocusPlugin} from '@lexical/react/LexicalAutoFocusPlugin';
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {LexicalErrorBoundary} from '@lexical/react/LexicalErrorBoundary';
import {HashtagPlugin} from '@lexical/react/LexicalHashtagPlugin';
import {HistoryPlugin} from '@lexical/react/LexicalHistoryPlugin';
import {LexicalNestedComposer} from '@lexical/react/LexicalNestedComposer';
import {RichTextPlugin} from '@lexical/react/LexicalRichTextPlugin';
import {useLexicalEditable} from '@lexical/react/useLexicalEditable';
import {useLexicalNodeSelection} from '@lexical/react/useLexicalNodeSelection';
import {mergeRegister} from '@lexical/utils';
import {
  $getNodeByKey,
  $getSelection,
  $isNodeSelection,
  $isRangeSelection,
  $setSelection,
  CLICK_COMMAND,
  COMMAND_PRIORITY_LOW,
  createCommand,
  DRAGSTART_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  SELECTION_CHANGE_COMMAND,
} from 'lexical';
import {Suspense, useCallback, useEffect, useRef, useState} from 'react';

import {useSharedHistoryContext} from '../../context/SharedHistoryContext';
const brokenImage = '/src/images/image-broken.svg';
import EmojisPlugin from '../../plugins/EmojisPlugin';
// LinkPlugin import removed; nested image-caption editor's LinkPlugin
// usage is commented out below.
import ContentEditable from '../../ui/ContentEditable';
import ImageResizer from '../../ui/ImageResizer';
import {$isImageNode} from './ImageNode';
import {getImagePluginCallbacks} from './index';
import {localAssetUrl} from '../../../utils/localAssetUrl';

const imageCache = new Map<string, Promise<boolean> | boolean>();

export const RIGHT_CLICK_IMAGE_COMMAND: LexicalCommand<MouseEvent> =
  createCommand('RIGHT_CLICK_IMAGE_COMMAND');

function useSuspenseImage(src: string) {
  let cached = imageCache.get(src);
  if (typeof cached === 'boolean') {
    return cached;
  } else if (!cached) {
    cached = new Promise<boolean>((resolve) => {
      const img = new Image();
      img.src = src;
      img.onload = () => resolve(false);
      img.onerror = () => resolve(true);
    }).then((hasError) => {
      imageCache.set(src, hasError);
      return hasError;
    });
    imageCache.set(src, cached);
    throw cached;
  }
  throw cached;
}

function isSVG(src: string): boolean {
  return src.toLowerCase().endsWith('.svg');
}

function LazyImage({
  altText,
  className,
  imageRef,
  src,
  width,
  height,
  maxWidth,
  onError,
}: {
  altText: string;
  className: string | null;
  height: 'inherit' | number;
  imageRef: {current: null | HTMLImageElement};
  maxWidth: number;
  src: string;
  width: 'inherit' | number;
  onError: () => void;
}): JSX.Element {
  const [dimensions, setDimensions] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const isSVGImage = isSVG(src);

  // src is already resolved by the parent ImageComponent
  const resolvedSrc = src;

  // Set initial dimensions for SVG images
  useEffect(() => {
    if (imageRef.current && isSVGImage) {
      const {naturalWidth, naturalHeight} = imageRef.current;
      setDimensions({
        height: naturalHeight,
        width: naturalWidth,
      });
    }
  }, [imageRef, isSVGImage]);

  const hasError = useSuspenseImage(resolvedSrc);

  useEffect(() => {
    if (hasError) {
      onError();
    }
  }, [hasError, onError]);

  if (hasError) {
    return <BrokenImage />;
  }

  // Calculate final dimensions with proper scaling
  const calculateDimensions = () => {
    if (!isSVGImage) {
      // For non-SVG images, just use the width and height without maxWidth constraint
      return {
        height,
        width,
      };
    }

    // Use natural dimensions if available, otherwise fallback to defaults
    const naturalWidth = dimensions?.width || 200;
    const naturalHeight = dimensions?.height || 200;

    let finalWidth = naturalWidth;
    let finalHeight = naturalHeight;

    // Scale down if width exceeds maxWidth while maintaining aspect ratio
    if (finalWidth > maxWidth) {
      const scale = maxWidth / finalWidth;
      finalWidth = maxWidth;
      finalHeight = Math.round(finalHeight * scale);
    }

    // Scale down if height exceeds maxHeight while maintaining aspect ratio
    const maxHeight = 10000;
    if (finalHeight > maxHeight) {
      const scale = maxHeight / finalHeight;
      finalHeight = maxHeight;
      finalWidth = Math.round(finalWidth * scale);
    }

    return {
      height: finalHeight,
      width: finalWidth,
    };
  };

  const imageStyle = calculateDimensions();

  return (
    <img
      className={className || undefined}
      src={resolvedSrc}
      alt={altText}
      ref={imageRef}
      style={imageStyle}
      onError={onError}
      draggable="false"
      onLoad={(e) => {
        if (isSVGImage) {
          const img = e.currentTarget;
          setDimensions({
            height: img.naturalHeight,
            width: img.naturalWidth,
          });
        }
      }}
    />
  );
}

function BrokenImage(): JSX.Element {
  return (
    <div
      className="collab-asset-unavailable-placeholder"
      style={{
        alignItems: 'center',
        color: 'var(--nim-text-muted)',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        justifyContent: 'center',
        minHeight: 200,
        minWidth: 200,
      }}
      role="img"
      aria-label="Image unavailable"
    >
      <img
        src={brokenImage}
        style={{height: 144, opacity: 0.2, width: 144}}
        draggable="false"
        alt=""
      />
      <span style={{fontSize: 12}}>Image unavailable</span>
    </div>
  );
}

// Helper function to get document path from TabEditor's data-file-path attribute
// This is stable per-editor instance, unlike window.__currentDocumentPath which is global
function getDocumentPathFromDOM(element: HTMLElement | null): string | null {
  if (!element) return null;
  let current: HTMLElement | null = element;
  while (current) {
    const filePath = current.getAttribute('data-file-path');
    if (filePath) return filePath;
    current = current.parentElement;
  }
  return null;
}

export default function ImageComponent({
  src,
  altText,
  nodeKey,
  width,
  height,
  maxWidth,
  resizable,
  showCaption,
  caption,
  captionsEnabled,
}: {
  altText: string;
  caption: LexicalEditor;
  height: 'inherit' | number;
  maxWidth: number;
  nodeKey: NodeKey;
  resizable: boolean;
  showCaption: boolean;
  src: string;
  width: 'inherit' | number;
  captionsEnabled: boolean;
}): JSX.Element {
  const imageRef = useRef<null | HTMLImageElement>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [isSelected, setSelected, clearSelection] =
    useLexicalNodeSelection(nodeKey);
  const [isResizing, setIsResizing] = useState<boolean>(false);
  // const {isCollabActive} = useCollaborationContext();
  const [editor] = useLexicalComposerContext();
  const [selection, setSelection] = useState<BaseSelection | null>(null);
  const activeEditorRef = useRef<LexicalEditor | null>(null);
  const [isLoadError, setIsLoadError] = useState<boolean>(false);
  const isEditable = useLexicalEditable();
  const [resolvedSrc, setResolvedSrc] = useState<string | null>(null);
  const [containerMounted, setContainerMounted] = useState(false);

  // Callback ref to detect when container is mounted
  const setContainerRef = useCallback((node: HTMLDivElement | null) => {
    containerRef.current = node;
    if (node) {
      setContainerMounted(true);
    }
  }, []);

  // Reset load error when src changes
  useEffect(() => {
    setIsLoadError(false);
  }, [src]);

  // Resolve image paths to renderer-loadable URLs.
  // Uses DOM traversal to find document path (stable per-editor instance).
  // Local-file URLs go through `localAssetUrl` so the platform layer can
  // route them through a custom protocol (Electron uses `nim-asset://`
  // because `webSecurity: true` blocks `<img src="file://...">`).
  useEffect(() => {
    let cancelled = false;

    const resolveSrc = async () => {
      // collab-asset:// is a registered standard+secure scheme -- the main
      // process handles fetch+decrypt and hands the bytes to Chromium. The
      // renderer must pass these URLs through untouched so we don't double-
      // resolve to a stale blob URL or mistake them for a relative path.
      if (src.startsWith('collab-asset://')) {
        if (!cancelled) {
          setResolvedSrc(src);
        }
        return;
      }

      const callbacks = getImagePluginCallbacks();

      if (callbacks.resolveImageSrc) {
        try {
          const resolved = await callbacks.resolveImageSrc(src);
          if (resolved) {
            imageCache.delete(src);
            if (!cancelled) {
              setResolvedSrc(resolved);
            }
            return;
          }
        } catch (error) {
          console.error('Failed to resolve image source', error);
        }
      }

      // file:// needs to be re-routed through the platform's local-asset URL
      // (nim-asset:// in Electron). Other absolute URL schemes pass through.
      if (src.startsWith('file://')) {
        const absolutePath = src.replace(/^file:\/\//, '');
        if (!cancelled) {
          imageCache.delete(src);
          setResolvedSrc(localAssetUrl(absolutePath));
        }
        return;
      }
      if (src.match(/^(https?|data|blob):/)) {
        if (!cancelled) {
          setResolvedSrc(src);
        }
        return;
      }

      // Handle .nimbalyst/assets/ paths via asset service
      if (src.includes('.nimbalyst/assets/') && typeof window !== 'undefined' && (window as any).electronAPI) {
        const match = src.match(/\.nimbalyst\/assets\/([a-f0-9]+)\./);
        if (match) {
          const hash = match[1];
          try {
            const absolutePath = await (window as any).electronAPI.invoke('document-service:get-asset-path', hash);
            if (!cancelled) {
              if (absolutePath) {
                imageCache.delete(src);
                setResolvedSrc(localAssetUrl(absolutePath));
              } else {
                setResolvedSrc(src);
              }
            }
          } catch {
            if (!cancelled) {
              setResolvedSrc(src);
            }
          }
          return;
        }
      }

      if (!containerMounted) {
        return;
      }

      const documentPath = getDocumentPathFromDOM(containerRef.current);
      if (!cancelled) {
        if (documentPath) {
          // Handle both POSIX and Windows separators -- on Windows the
          // document path is "C:\\foo\\bar.md" with backslashes.
          const lastSep = Math.max(
            documentPath.lastIndexOf('/'),
            documentPath.lastIndexOf('\\'),
          );
          const documentDir = lastSep >= 0 ? documentPath.substring(0, lastSep) : '';
          const absolutePath = documentDir + '/' + src;
          setResolvedSrc(localAssetUrl(absolutePath));
        } else {
          setResolvedSrc(src);
        }
      }
    };

    void resolveSrc();

    return () => {
      cancelled = true;
    };
  }, [src, containerMounted]);

  const $onEnter = useCallback(
    (event: KeyboardEvent) => {
      const latestSelection = $getSelection();
      const buttonElem = buttonRef.current;
      if (
        isSelected &&
        $isNodeSelection(latestSelection) &&
        latestSelection.getNodes().length === 1
      ) {
        if (showCaption) {
          // Move focus into nested editor
          $setSelection(null);
          event.preventDefault();
          caption.focus();
          return true;
        } else if (
          buttonElem !== null &&
          buttonElem !== document.activeElement
        ) {
          event.preventDefault();
          buttonElem.focus();
          return true;
        }
      }
      return false;
    },
    [caption, isSelected, showCaption],
  );

  const $onEscape = useCallback(
    (event: KeyboardEvent) => {
      if (
        activeEditorRef.current === caption ||
        buttonRef.current === event.target
      ) {
        $setSelection(null);
        editor.update(() => {
          setSelected(true);
          const parentRootElement = editor.getRootElement();
          if (parentRootElement !== null) {
            parentRootElement.focus();
          }
        });
        return true;
      }
      return false;
    },
    [caption, editor, setSelected],
  );

  const onClick = useCallback(
    (payload: MouseEvent) => {
      const event = payload;

      if (isResizing) {
        return true;
      }
      if (event.target === imageRef.current) {
        if (event.shiftKey) {
          setSelected(!isSelected);
        } else {
          clearSelection();
          setSelected(true);
        }
        return true;
      }

      return false;
    },
    [isResizing, isSelected, setSelected, clearSelection],
  );

  const onDoubleClick = useCallback(
    (event: MouseEvent) => {
      if (event.target === imageRef.current && resolvedSrc) {
        const callbacks = getImagePluginCallbacks();
        if (callbacks.onImageDoubleClick) {
          callbacks.onImageDoubleClick(resolvedSrc, nodeKey);
        }
        return true;
      }
      return false;
    },
    [resolvedSrc, nodeKey],
  );

  const onRightClick = useCallback(
    (event: MouseEvent): void => {
      editor.getEditorState().read(() => {
        const latestSelection = $getSelection();
        const domElement = event.target as HTMLElement;
        if (
          domElement.tagName === 'IMG' &&
          $isRangeSelection(latestSelection) &&
          latestSelection.getNodes().length === 1
        ) {
          editor.dispatchCommand(
            RIGHT_CLICK_IMAGE_COMMAND,
            event as MouseEvent,
          );
        }
      });
    },
    [editor],
  );

  useEffect(() => {
    const rootElement = editor.getRootElement();
    const unregister = mergeRegister(
      editor.registerUpdateListener(({editorState}) => {
        const updatedSelection = editorState.read(() => $getSelection());
        if ($isNodeSelection(updatedSelection)) {
          setSelection(updatedSelection);
        } else {
          setSelection(null);
        }
      }),
      editor.registerCommand(
        SELECTION_CHANGE_COMMAND,
        (_, activeEditor) => {
          activeEditorRef.current = activeEditor;
          return false;
        },
        COMMAND_PRIORITY_LOW,
      ),
      editor.registerCommand<MouseEvent>(
        CLICK_COMMAND,
        onClick,
        COMMAND_PRIORITY_LOW,
      ),
      editor.registerCommand<MouseEvent>(
        RIGHT_CLICK_IMAGE_COMMAND,
        onClick,
        COMMAND_PRIORITY_LOW,
      ),
      editor.registerCommand(
        DRAGSTART_COMMAND,
        (event) => {
          if (event.target === imageRef.current) {
            // Call platform-specific drag callback if provided
            if (resolvedSrc) {
              const callbacks = getImagePluginCallbacks();
              if (callbacks.onImageDragStart) {
                callbacks.onImageDragStart(resolvedSrc, event);
              }
            }
            // TODO This is just a temporary workaround for FF to behave like other browsers.
            // Ideally, this handles drag & drop too (and all browsers).
            event.preventDefault();
            return true;
          }
          return false;
        },
        COMMAND_PRIORITY_LOW,
      ),
      editor.registerCommand(KEY_ENTER_COMMAND, $onEnter, COMMAND_PRIORITY_LOW),
      editor.registerCommand(
        KEY_ESCAPE_COMMAND,
        $onEscape,
        COMMAND_PRIORITY_LOW,
      ),
    );

    rootElement?.addEventListener('contextmenu', onRightClick);

    // Add double-click listener to image element
    const imgElement = imageRef.current;
    if (imgElement) {
      imgElement.addEventListener('dblclick', onDoubleClick as any);
    }

    return () => {
      unregister();
      rootElement?.removeEventListener('contextmenu', onRightClick);
      if (imgElement) {
        imgElement.removeEventListener('dblclick', onDoubleClick as any);
      }
    };
  }, [
    clearSelection,
    editor,
    isResizing,
    isSelected,
    nodeKey,
    $onEnter,
    $onEscape,
    onClick,
    onDoubleClick,
    onRightClick,
    setSelected,
    resolvedSrc,
  ]);

  const setShowCaption = () => {
    editor.update(() => {
      const node = $getNodeByKey(nodeKey);
      if ($isImageNode(node)) {
        node.setShowCaption(true);
      }
    });
  };

  const onResizeEnd = (
    nextWidth: 'inherit' | number,
    nextHeight: 'inherit' | number,
  ) => {
    // Delay hiding the resize bars for click case
    setTimeout(() => {
      setIsResizing(false);
    }, 200);

    editor.update(() => {
      const node = $getNodeByKey(nodeKey);
      if ($isImageNode(node)) {
        node.setWidthAndHeight(nextWidth, nextHeight);
      }
    });
  };

  const onResizeStart = () => {
    setIsResizing(true);
  };

  const {historyState} = useSharedHistoryContext();

  const draggable = isSelected && $isNodeSelection(selection) && !isResizing;
  const isFocused = (isSelected || isResizing) && isEditable;

  return (
    <Suspense fallback={null}>
      <div ref={setContainerRef}>
        {!resolvedSrc ? (
          <div style={{ width, height, minHeight: 100 }}>Loading...</div>
        ) : (
          <>
            <div draggable={draggable}>
              {isLoadError ? (
                <BrokenImage />
              ) : (
                <LazyImage
                  className={
                    isFocused
                      ? `focused ${$isNodeSelection(selection) ? 'draggable' : ''}`
                      : null
                  }
                  src={resolvedSrc}
                  altText={altText}
                  imageRef={imageRef}
                  width={width}
                  height={height}
                  maxWidth={maxWidth}
                  onError={() => setIsLoadError(true)}
                />
              )}
            </div>

            {showCaption && (
              <div className="image-caption-container">
                <LexicalNestedComposer initialEditor={caption}>
                  <AutoFocusPlugin />
                  {/*<LinkPlugin />*/}
                  {/*<EmojisPlugin />*/}
                  {/*<HashtagPlugin />*/}
                  {/* Collaboration disabled */}
                  {/* {isCollabActive ? (
                    <CollaborationPlugin
                      id={caption.getKey()}
                      // providerFactory={createWebsocketProvider}
                      shouldBootstrap={true}
                    />
                  ) : ( */}
                    <HistoryPlugin externalHistoryState={historyState} />
                  {/* )} */}
                  <RichTextPlugin
                    contentEditable={
                      <ContentEditable
                        placeholder="Enter a caption..."
                        placeholderClassName="ImageNode__placeholder"
                        className="ImageNode__contentEditable"
                      />
                    }
                    ErrorBoundary={LexicalErrorBoundary}
                  />
                </LexicalNestedComposer>
              </div>
            )}
            {resizable && $isNodeSelection(selection) && isFocused && (
              <ImageResizer
                showCaption={showCaption}
                setShowCaption={setShowCaption}
                editor={editor}
                buttonRef={buttonRef}
                imageRef={imageRef}
                maxWidth={maxWidth}
                onResizeStart={onResizeStart}
                onResizeEnd={onResizeEnd}
                captionsEnabled={false}
                // captionsEnabled={!isLoadError && captionsEnabled}
              />
            )}
          </>
        )}
      </div>
    </Suspense>
  );
}
