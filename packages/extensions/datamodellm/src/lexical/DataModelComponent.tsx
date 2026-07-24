/**
 * DataModelComponent - React component for rendering DataModelNode.
 *
 * Displays the data model screenshot with an edit button overlay.
 * Supports resizing and selection like ImageComponent.
 */

import type { LexicalEditor, NodeKey } from 'lexical';
import type { JSX } from 'react';

import './DataModelNode.css';

import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { useLexicalEditable } from '@lexical/react/useLexicalEditable';
import { useLexicalNodeSelection } from '@lexical/react/useLexicalNodeSelection';
import { calculateZoomLevel, mergeRegister } from '@lexical/utils';
import {
  $getNodeByKey,
  $getSelection,
  $isNodeSelection,
  CLICK_COMMAND,
  COMMAND_PRIORITY_LOW,
  type BaseSelection,
} from 'lexical';
import * as React from 'react';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  getDataModelPlatformService,
  hasDataModelPlatformService,
} from './DataModelPlatformService';
import { $isDataModelNode } from './DataModelNode';
import { useDocumentPath } from '@nimbalyst/extension-sdk';

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

const Direction = {
  east: 1 << 0,
  north: 1 << 3,
  south: 1 << 1,
  west: 1 << 2,
};

// Full-featured resizer matching ImageResizer behavior
function DataModelResizer({
  onResizeStart,
  onResizeEnd,
  imageRef,
  editor,
}: {
  editor: LexicalEditor;
  imageRef: React.RefObject<HTMLElement | null>;
  onResizeEnd: (width: 'inherit' | number, height: 'inherit' | number) => void;
  onResizeStart: () => void;
}): JSX.Element {
  const controlWrapperRef = useRef<HTMLDivElement>(null);
  const userSelect = useRef({
    priority: '',
    value: 'default',
  });
  const positioningRef = useRef<{
    currentHeight: 'inherit' | number;
    currentWidth: 'inherit' | number;
    direction: number;
    isResizing: boolean;
    ratio: number;
    startHeight: number;
    startWidth: number;
    startX: number;
    startY: number;
  }>({
    currentHeight: 0,
    currentWidth: 0,
    direction: 0,
    isResizing: false,
    ratio: 0,
    startHeight: 0,
    startWidth: 0,
    startX: 0,
    startY: 0,
  });

  const editorRootElement = editor.getRootElement();
  const maxWidthContainer = 10000;
  const maxHeightContainer = 10000;
  const minWidth = 100;
  const minHeight = 100;

  const setStartCursor = (direction: number) => {
    const ew = direction === Direction.east || direction === Direction.west;
    const ns = direction === Direction.north || direction === Direction.south;
    const nwse =
      (direction & Direction.north && direction & Direction.west) ||
      (direction & Direction.south && direction & Direction.east);

    const cursorDir = ew ? 'ew' : ns ? 'ns' : nwse ? 'nwse' : 'nesw';

    if (editorRootElement !== null) {
      editorRootElement.style.setProperty(
        'cursor',
        `${cursorDir}-resize`,
        'important',
      );
    }
    if (document.body !== null) {
      document.body.style.setProperty(
        'cursor',
        `${cursorDir}-resize`,
        'important',
      );
      userSelect.current.value = document.body.style.getPropertyValue(
        '-webkit-user-select',
      );
      userSelect.current.priority = document.body.style.getPropertyPriority(
        '-webkit-user-select',
      );
      document.body.style.setProperty(
        '-webkit-user-select',
        `none`,
        'important',
      );
    }
  };

  const setEndCursor = () => {
    if (editorRootElement !== null) {
      editorRootElement.style.setProperty('cursor', 'text');
    }
    if (document.body !== null) {
      document.body.style.setProperty('cursor', 'default');
      document.body.style.setProperty(
        '-webkit-user-select',
        userSelect.current.value,
        userSelect.current.priority,
      );
    }
  };

  const handlePointerDown = (
    event: React.PointerEvent<HTMLDivElement>,
    direction: number,
  ) => {
    if (!editor.isEditable()) {
      return;
    }

    const image = imageRef.current;
    const controlWrapper = controlWrapperRef.current;

    if (image !== null && controlWrapper !== null) {
      event.preventDefault();
      const { width, height } = image.getBoundingClientRect();
      const zoom = calculateZoomLevel(image);
      const positioning = positioningRef.current;
      positioning.startWidth = width;
      positioning.startHeight = height;
      positioning.ratio = width / height;
      positioning.currentWidth = width;
      positioning.currentHeight = height;
      positioning.startX = event.clientX / zoom;
      positioning.startY = event.clientY / zoom;
      positioning.isResizing = true;
      positioning.direction = direction;

      setStartCursor(direction);
      onResizeStart();

      controlWrapper.classList.add('datamodel-control-wrapper--resizing');
      image.style.height = `${height}px`;
      image.style.width = `${width}px`;

      document.addEventListener('pointermove', handlePointerMove);
      document.addEventListener('pointerup', handlePointerUp);
    }
  };

  const handlePointerMove = (event: PointerEvent) => {
    const image = imageRef.current;
    const positioning = positioningRef.current;

    const isHorizontal =
      positioning.direction & (Direction.east | Direction.west);
    const isVertical =
      positioning.direction & (Direction.south | Direction.north);

    if (image !== null && positioning.isResizing) {
      const zoom = calculateZoomLevel(image);
      // Corner cursor
      if (isHorizontal && isVertical) {
        let diff = Math.floor(positioning.startX - event.clientX / zoom);
        diff = positioning.direction & Direction.east ? -diff : diff;

        const width = clamp(
          positioning.startWidth + diff,
          minWidth,
          maxWidthContainer,
        );

        const height = width / positioning.ratio;
        image.style.width = `${width}px`;
        image.style.height = `${height}px`;
        positioning.currentHeight = height;
        positioning.currentWidth = width;
      } else if (isVertical) {
        let diff = Math.floor(positioning.startY - event.clientY / zoom);
        diff = positioning.direction & Direction.south ? -diff : diff;

        const height = clamp(
          positioning.startHeight + diff,
          minHeight,
          maxHeightContainer,
        );

        image.style.height = `${height}px`;
        positioning.currentHeight = height;
      } else {
        let diff = Math.floor(positioning.startX - event.clientX / zoom);
        diff = positioning.direction & Direction.east ? -diff : diff;

        const width = clamp(
          positioning.startWidth + diff,
          minWidth,
          maxWidthContainer,
        );

        image.style.width = `${width}px`;
        positioning.currentWidth = width;
      }
    }
  };

  const handlePointerUp = () => {
    const image = imageRef.current;
    const positioning = positioningRef.current;
    const controlWrapper = controlWrapperRef.current;
    if (image !== null && controlWrapper !== null && positioning.isResizing) {
      const width = positioning.currentWidth;
      const height = positioning.currentHeight;
      positioning.startWidth = 0;
      positioning.startHeight = 0;
      positioning.ratio = 0;
      positioning.startX = 0;
      positioning.startY = 0;
      positioning.currentWidth = 0;
      positioning.currentHeight = 0;
      positioning.isResizing = false;

      controlWrapper.classList.remove('datamodel-control-wrapper--resizing');

      setEndCursor();
      onResizeEnd(width, height);

      document.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('pointerup', handlePointerUp);
    }
  };

  return (
    <div ref={controlWrapperRef} className="datamodel-resizer">
      <div
        className="datamodel-resizer-handle datamodel-resizer-n"
        onPointerDown={(event) => {
          handlePointerDown(event, Direction.north);
        }}
      />
      <div
        className="datamodel-resizer-handle datamodel-resizer-ne"
        onPointerDown={(event) => {
          handlePointerDown(event, Direction.north | Direction.east);
        }}
      />
      <div
        className="datamodel-resizer-handle datamodel-resizer-e"
        onPointerDown={(event) => {
          handlePointerDown(event, Direction.east);
        }}
      />
      <div
        className="datamodel-resizer-handle datamodel-resizer-se"
        onPointerDown={(event) => {
          handlePointerDown(event, Direction.south | Direction.east);
        }}
      />
      <div
        className="datamodel-resizer-handle datamodel-resizer-s"
        onPointerDown={(event) => {
          handlePointerDown(event, Direction.south);
        }}
      />
      <div
        className="datamodel-resizer-handle datamodel-resizer-sw"
        onPointerDown={(event) => {
          handlePointerDown(event, Direction.south | Direction.west);
        }}
      />
      <div
        className="datamodel-resizer-handle datamodel-resizer-w"
        onPointerDown={(event) => {
          handlePointerDown(event, Direction.west);
        }}
      />
      <div
        className="datamodel-resizer-handle datamodel-resizer-nw"
        onPointerDown={(event) => {
          handlePointerDown(event, Direction.north | Direction.west);
        }}
      />
    </div>
  );
}

export default function DataModelComponent({
  dataModelPath,
  screenshotPath,
  altText,
  width,
  height,
  nodeKey,
  resizable,
}: {
  dataModelPath: string;
  screenshotPath: string;
  altText: string;
  width: 'inherit' | number;
  height: 'inherit' | number;
  nodeKey: NodeKey;
  resizable: boolean;
}): JSX.Element {
  const imageRef = useRef<HTMLImageElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [isSelected, setSelected, clearSelection] =
    useLexicalNodeSelection(nodeKey);
  const [isResizing, setIsResizing] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [selection, setSelection] = useState<BaseSelection | null>(null);
  const [editor] = useLexicalComposerContext();
  const isEditable = useLexicalEditable();
  const [resolvedScreenshotSrcOverride, setResolvedScreenshotSrcOverride] = useState<
    string | null
  >(null);
  const [isLoadError, setIsLoadError] = useState(false);
  const [isRefreshingScreenshot, setIsRefreshingScreenshot] = useState(false);
  const screenshotRefreshCheckedRef = useRef(false);

  // Get document path from context - stable per-editor instance
  const { documentPath, documentDir } = useDocumentPath();

  // Compute resolved screenshot path
  const resolvedScreenshotSrc = useMemo((): string | null => {
    if (!screenshotPath) {
      return null;
    }

    // If there's an override (from cache-busting after refresh), use it
    if (resolvedScreenshotSrcOverride) {
      return resolvedScreenshotSrcOverride;
    }

    // If it's already an absolute URL, use as-is
    if (screenshotPath.match(/^(https?|file|data):/)) {
      return screenshotPath;
    }

    // Resolve relative path using document directory from context
    if (documentDir) {
      const absolutePath = documentDir + '/' + screenshotPath;
      return 'file://' + absolutePath;
    }

    // No document path available yet - return null to show loading state
    return null;
  }, [screenshotPath, resolvedScreenshotSrcOverride, documentDir]);

  // Check if screenshot needs refresh (source file newer than screenshot by >5 seconds)
  useEffect(() => {
    // Only check once per mount
    if (screenshotRefreshCheckedRef.current) {
      return;
    }

    if (!hasDataModelPlatformService() || !screenshotPath || !dataModelPath || !documentPath) {
      return;
    }

    const checkAndRefreshScreenshot = async () => {
      screenshotRefreshCheckedRef.current = true;

      const service = getDataModelPlatformService();

      // Resolve absolute paths using document path from context
      let absoluteDataModelPath = dataModelPath;
      let absoluteScreenshotPath = screenshotPath;

      if (!dataModelPath.startsWith('/')) {
        absoluteDataModelPath = service.resolveRelativePath(dataModelPath, documentPath);
      }

      if (!screenshotPath.startsWith('/') && !screenshotPath.match(/^(https?|file|data):/)) {
        absoluteScreenshotPath = service.resolveRelativePath(screenshotPath, documentPath);
      }

      try {
        // Check if both files exist
        const [sourceExists, screenshotExists] = await Promise.all([
          service.fileExists(absoluteDataModelPath),
          service.fileExists(absoluteScreenshotPath),
        ]);

        if (!sourceExists) {
          return;
        }

        // If screenshot doesn't exist, we need to create it
        if (!screenshotExists) {
          setIsRefreshingScreenshot(true);
          await service.captureScreenshot(absoluteDataModelPath, absoluteScreenshotPath);
          // Force reload by updating the src with a cache-busting query
          setResolvedScreenshotSrcOverride('file://' + absoluteScreenshotPath + '?t=' + Date.now());
          setIsRefreshingScreenshot(false);
          return;
        }

        // Get modification times
        const [sourceModTime, screenshotModTime] = await Promise.all([
          service.getFileModifiedTime(absoluteDataModelPath),
          service.getFileModifiedTime(absoluteScreenshotPath),
        ]);

        // If source is more than 5 seconds newer than screenshot, refresh
        const REFRESH_THRESHOLD_MS = 5000;
        if (sourceModTime > screenshotModTime + REFRESH_THRESHOLD_MS) {
          setIsRefreshingScreenshot(true);
          await service.captureScreenshot(absoluteDataModelPath, absoluteScreenshotPath);
          // Force reload by updating the src with a cache-busting query
          setResolvedScreenshotSrcOverride('file://' + absoluteScreenshotPath + '?t=' + Date.now());
          setIsRefreshingScreenshot(false);
        }
      } catch (error) {
        console.error('[DataModelComponent] Failed to check/refresh screenshot:', error);
        setIsRefreshingScreenshot(false);
      }
    };

    checkAndRefreshScreenshot();
  }, [dataModelPath, screenshotPath, documentPath]);

  // Handle click selection
  const onClick = useCallback(
    (payload: MouseEvent) => {
      const event = payload;

      if (isResizing) {
        return true;
      }

      if (
        containerRef.current &&
        containerRef.current.contains(event.target as Node)
      ) {
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

  // Register event handlers
  useEffect(() => {
    return mergeRegister(
      editor.registerCommand<MouseEvent>(
        CLICK_COMMAND,
        onClick,
        COMMAND_PRIORITY_LOW,
      ),
      editor.registerUpdateListener(({ editorState }) => {
        const updatedSelection = editorState.read(() => $getSelection());
        if ($isNodeSelection(updatedSelection)) {
          setSelection(updatedSelection);
        } else {
          setSelection(null);
        }
      }),
    );
  }, [editor, onClick]);

  // Handle edit button click
  const handleEditClick = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      event.preventDefault();

      if (!hasDataModelPlatformService()) {
        console.warn('DataModelPlatformService not available');
        return;
      }

      const service = getDataModelPlatformService();

      // Resolve the data model path using document path from context
      let absoluteDataModelPath = dataModelPath;
      if (documentPath && !dataModelPath.startsWith('/')) {
        absoluteDataModelPath = service.resolveRelativePath(dataModelPath, documentPath);
      }

      service.openDataModelEditor(absoluteDataModelPath);
    },
    [dataModelPath, documentPath],
  );

  // Handle resize
  const onResizeEnd = useCallback(
    (nextWidth: 'inherit' | number, nextHeight: 'inherit' | number) => {
      setTimeout(() => {
        setIsResizing(false);
      }, 200);

      editor.update(() => {
        const node = $getNodeByKey(nodeKey);
        if ($isDataModelNode(node)) {
          node.setWidthAndHeight(nextWidth, nextHeight);
        }
      });
    },
    [editor, nodeKey],
  );

  const onResizeStart = useCallback(() => {
    setIsResizing(true);
  }, []);

  const isFocused = (isSelected || isResizing) && isEditable;
  const showEditButton = (isHovered || isSelected) && isEditable;

  if (!resolvedScreenshotSrc) {
    return (
      <div
        ref={containerRef}
        className="datamodel-container datamodel-loading"
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        <div className="datamodel-placeholder">
          <span className="datamodel-spinner" />
          Generating screenshot...
        </div>
        {showEditButton && (
          <button
            className="datamodel-edit-button"
            onClick={handleEditClick}
            title="Edit data model"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
            Edit
          </button>
        )}
      </div>
    );
  }

  return (
    <Suspense fallback={null}>
      <div
        ref={containerRef}
        className={`datamodel-container ${isFocused ? 'focused' : ''}`}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        {isLoadError ? (
          <div className="datamodel-error">
            <span className="datamodel-error-icon">!</span>
            <span className="datamodel-error-text">Screenshot not found</span>
            <span className="datamodel-error-hint">Click Edit to open the data model</span>
          </div>
        ) : (
          <>
            <img
              ref={imageRef}
              className={`datamodel-image ${isFocused ? 'focused' : ''} ${isRefreshingScreenshot ? 'refreshing' : ''}`}
              src={resolvedScreenshotSrc}
              alt={altText}
              style={{
                width: width !== 'inherit' ? width : undefined,
                height: height !== 'inherit' ? height : undefined,
              }}
              onError={() => setIsLoadError(true)}
              draggable={false}
            />
            {isRefreshingScreenshot && (
              <div className="datamodel-refresh-overlay">
                <span className="datamodel-spinner" />
                Updating screenshot...
              </div>
            )}
          </>
        )}

        {showEditButton && (
          <button
            className="datamodel-edit-button"
            onClick={handleEditClick}
            title="Edit data model"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
            Edit
          </button>
        )}

        {resizable && $isNodeSelection(selection) && isFocused && (
          <DataModelResizer
            editor={editor}
            imageRef={imageRef}
            onResizeStart={onResizeStart}
            onResizeEnd={onResizeEnd}
          />
        )}
      </div>
    </Suspense>
  );
}
