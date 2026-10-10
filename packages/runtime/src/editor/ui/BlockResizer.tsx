/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/**
 * Drag handles for a block (image, 2x2, placed view, ...): eight around a
 * selected block, or one bottom-right grip (`handles="corner"`). Corners keep
 * the aspect ratio unless `keepAspectRatio` is false; edges change one
 * dimension. The target's inline size is set live while dragging and the
 * final size is reported once on release, so the node writes once. Handles
 * position against the nearest positioned ancestor; styles are
 * `.block-resizer` and `.block-resizer-grip` in `index.css`.
 */

import type {LexicalEditor} from 'lexical';
import type {JSX} from 'react';

import {calculateZoomLevel} from '@lexical/utils';
import * as React from 'react';
import {useRef} from 'react';

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

const Direction = {
  east: 1 << 0,
  north: 1 << 3,
  south: 1 << 1,
  west: 1 << 2,
};

const HANDLES: Array<[string, number]> = [
  ['n', Direction.north],
  ['ne', Direction.north | Direction.east],
  ['e', Direction.east],
  ['se', Direction.south | Direction.east],
  ['s', Direction.south],
  ['sw', Direction.south | Direction.west],
  ['w', Direction.west],
  ['nw', Direction.north | Direction.west],
];

const CORNER_HANDLES: Array<[string, number]> = [['se', Direction.south | Direction.east]];

export interface BlockResizerProps {
  editor: LexicalEditor;
  /** The element whose width/height the handles drag. */
  targetRef: {current: null | HTMLElement};
  onResizeStart: () => void;
  onResizeEnd: (width: number, height: number) => void;
  /** Called on every move with the live size, for content that must follow the drag. */
  onResize?: (width: number, height: number) => void;
  minWidth?: number;
  minHeight?: number;
  maxWidth?: number;
  maxHeight?: number;
  /** `all` draws eight handles; `corner` draws only the bottom-right grip. */
  handles?: 'all' | 'corner';
  /** Whether a corner drag keeps the starting aspect ratio. */
  keepAspectRatio?: boolean;
  /** Double-clicking a handle calls this, e.g. to go back to the automatic size. */
  onReset?: () => void;
  /** Rendered inside the handle wrapper (e.g. the image's caption button). */
  children?: React.ReactNode;
}

export default function BlockResizer({
  editor,
  targetRef,
  onResizeStart,
  onResizeEnd,
  onResize,
  minWidth = 100,
  minHeight = 100,
  // Very large defaults effectively remove the constraint.
  maxWidth = 10000,
  maxHeight = 10000,
  handles = 'all',
  keepAspectRatio = true,
  onReset,
  children,
}: BlockResizerProps): JSX.Element {
  const controlWrapperRef = useRef<HTMLDivElement>(null);
  const userSelect = useRef({
    priority: '',
    value: 'default',
  });
  const positioningRef = useRef({
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

    const target = targetRef.current;
    const controlWrapper = controlWrapperRef.current;

    if (target !== null && controlWrapper !== null) {
      event.preventDefault();
      const {width, height} = target.getBoundingClientRect();
      const zoom = calculateZoomLevel(target);
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

      controlWrapper.classList.add('block-resizer-wrapper--resizing');
      target.style.height = `${height}px`;
      target.style.width = `${width}px`;

      document.addEventListener('pointermove', handlePointerMove);
      document.addEventListener('pointerup', handlePointerUp);
    }
  };
  const handlePointerMove = (event: PointerEvent) => {
    const target = targetRef.current;
    const positioning = positioningRef.current;

    const isHorizontal =
      positioning.direction & (Direction.east | Direction.west);
    const isVertical =
      positioning.direction & (Direction.south | Direction.north);

    if (target !== null && positioning.isResizing) {
      const zoom = calculateZoomLevel(target);
      // Corner cursor
      if (isHorizontal && isVertical && !keepAspectRatio) {
        let dx = Math.floor(positioning.startX - event.clientX / zoom);
        dx = positioning.direction & Direction.east ? -dx : dx;
        let dy = Math.floor(positioning.startY - event.clientY / zoom);
        dy = positioning.direction & Direction.south ? -dy : dy;

        const width = clamp(positioning.startWidth + dx, minWidth, maxWidth);
        const height = clamp(positioning.startHeight + dy, minHeight, maxHeight);
        target.style.width = `${width}px`;
        target.style.height = `${height}px`;
        positioning.currentHeight = height;
        positioning.currentWidth = width;
      } else if (isHorizontal && isVertical) {
        let diff = Math.floor(positioning.startX - event.clientX / zoom);
        diff = positioning.direction & Direction.east ? -diff : diff;

        const width = clamp(positioning.startWidth + diff, minWidth, maxWidth);

        const height = width / positioning.ratio;
        target.style.width = `${width}px`;
        target.style.height = `${height}px`;
        positioning.currentHeight = height;
        positioning.currentWidth = width;
      } else if (isVertical) {
        let diff = Math.floor(positioning.startY - event.clientY / zoom);
        diff = positioning.direction & Direction.south ? -diff : diff;

        const height = clamp(
          positioning.startHeight + diff,
          minHeight,
          maxHeight,
        );

        target.style.height = `${height}px`;
        positioning.currentHeight = height;
      } else {
        let diff = Math.floor(positioning.startX - event.clientX / zoom);
        diff = positioning.direction & Direction.east ? -diff : diff;

        const width = clamp(positioning.startWidth + diff, minWidth, maxWidth);

        target.style.width = `${width}px`;
        positioning.currentWidth = width;
      }
      onResize?.(positioning.currentWidth, positioning.currentHeight);
    }
  };
  const handlePointerUp = () => {
    const target = targetRef.current;
    const positioning = positioningRef.current;
    const controlWrapper = controlWrapperRef.current;
    if (target !== null && controlWrapper !== null && positioning.isResizing) {
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

      controlWrapper.classList.remove('block-resizer-wrapper--resizing');

      setEndCursor();
      onResizeEnd(width, height);

      document.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('pointerup', handlePointerUp);
    }
  };
  return (
    <div ref={controlWrapperRef}>
      {children}
      {(handles === 'corner' ? CORNER_HANDLES : HANDLES).map(([name, direction]) => (
        <div
          key={name}
          className={handles === 'corner' ? 'block-resizer-grip' : `block-resizer block-resizer-${name}`}
          data-testid={handles === 'corner' ? 'block-resizer-grip' : undefined}
          onPointerDown={(event) => {
            handlePointerDown(event, direction);
          }}
          onDoubleClick={onReset && editor.isEditable() ? (event) => {
            event.preventDefault();
            onReset();
          } : undefined}
        />
      ))}
    </div>
  );
}
