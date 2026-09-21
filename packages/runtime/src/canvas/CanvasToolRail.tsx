/**
 * The board's tool rail: what the pointer does, and what a click creates.
 *
 * This is the old top-left `canvas-toolbar` moved out of CanvasSurface and
 * stood on end, with the two pointer tools added above it. The creation buttons
 * behave exactly as they did -- each one drops a card at the viewport centre and
 * selects it -- and the pin and "save view" affordances keep their existing
 * one-shot and commit semantics.
 *
 * Select and hand are a *mode*, not an action: they flip React Flow's
 * `panOnDrag` / `selectionOnDrag` pair in the surface (complication 1). They sit
 * above a separator because everything below them adds something to the board
 * and they do not.
 *
 * The key letters are painted as corner hints rather than put in the tooltip
 * alone, because a rail of unlabelled icons is only learnable if the shortcut is
 * visible next to the thing it triggers. They are the same letters
 * `canvasKeymap` resolves; a tool with no shortcut simply has no hint.
 */
import type { ReactElement } from 'react';
import { Panel } from '@xyflow/react';

import { MaterialSymbol } from '../ui/icons/MaterialSymbol';
import type { CanvasPointerTool } from './canvasPanelState';

export interface CanvasToolRailProps {
  tool: CanvasPointerTool;
  onToolChange(tool: CanvasPointerTool): void;
  readOnly: boolean;
  onAddCard(kind: 'sticky' | 'text' | 'image' | 'group'): void;
  /** Absent when the host cannot pick a file or shared document. */
  onAddReference?: (() => void) | undefined;
  /** Absent when the board has no comment room. */
  onTogglePin?: (() => void) | undefined;
  pinPlacement: boolean;
  onSaveView(): void;
}

function RailButton({
  icon,
  label,
  hint,
  active,
  onClick,
}: {
  icon: string;
  label: string;
  hint?: string;
  active?: boolean;
  onClick(): void;
}): ReactElement {
  return (
    <button
      type="button"
      className={
        active === true
          ? 'canvas-tool-rail__button canvas-tool-rail__button--active'
          : 'canvas-tool-rail__button'
      }
      data-canvas-help={`canvas-tool-${icon.replace(/_/g, '-')}`}
      data-testid={`canvas-tool-${icon.replace(/_/g, '-')}`}
      aria-label={label}
      {...(active === undefined ? {} : { 'aria-pressed': active })}
      onClick={onClick}
    >
      <MaterialSymbol icon={icon} size={18} />
      {hint !== undefined && (
        <span className="canvas-tool-rail__hint" aria-hidden>
          {hint}
        </span>
      )}
    </button>
  );
}

export function CanvasToolRail({
  tool,
  onToolChange,
  readOnly,
  onAddCard,
  onAddReference,
  onTogglePin,
  pinPlacement,
  onSaveView,
}: CanvasToolRailProps): ReactElement {
  return (
    <Panel position="top-left" className="canvas-tool-rail">
      <RailButton
        icon="arrow_selector_tool"
        label="Select"
        hint="V"
        active={tool === 'select'}
        onClick={() => onToolChange('select')}
      />
      <RailButton
        icon="pan_tool"
        label="Hand"
        hint="H"
        active={tool === 'hand'}
        onClick={() => onToolChange('hand')}
      />
      {!readOnly && (
        <>
          <span className="canvas-tool-rail__separator" aria-hidden />
          <RailButton
            icon="sticky_note_2"
            label="Sticky"
            hint="N"
            onClick={() => onAddCard('sticky')}
          />
          <RailButton
            icon="title"
            label="Text"
            hint="T"
            onClick={() => onAddCard('text')}
          />
          <RailButton
            icon="image"
            label="Image"
            onClick={() => onAddCard('image')}
          />
          <RailButton
            icon="crop_square"
            label="Frame"
            hint="F"
            onClick={() => onAddCard('group')}
          />
          {onAddReference !== undefined && (
            <RailButton
              icon="description"
              label="Put an existing file or shared document on the board"
              onClick={onAddReference}
            />
          )}
          {onTogglePin !== undefined && (
            <RailButton
              icon="add_comment"
              label="Drop a comment pin anywhere on the board"
              hint="M"
              active={pinPlacement}
              onClick={onTogglePin}
            />
          )}
          <span className="canvas-tool-rail__separator" aria-hidden />
          <RailButton
            icon="bookmark_add"
            label="Store the current position and zoom as this board's starting view"
            onClick={onSaveView}
          />
        </>
      )}
    </Panel>
  );
}
