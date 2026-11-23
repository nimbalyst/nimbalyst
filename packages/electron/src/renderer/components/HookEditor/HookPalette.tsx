/**
 * The block palette: two cards, each with a dropdown you can type into. Pick
 * a "When" event and click Add to start a new hook on it. Pick an action or
 * Then block and click Add to add it where the selection is. A block that does
 * not fit says why. Each card's chip can also be dragged onto the canvas.
 */

import { useDraggable } from '@dnd-kit/core';
import { FloatingFocusManager, FloatingPortal, flip, offset, shift, useDismiss, useFloating, useInteractions, type ReferenceType } from '@floating-ui/react';
import { useEffect, useRef, useState, type PointerEventHandler } from 'react';

import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';

import type { SettingsSource } from '../../../main/services/hookEditor/hookFiles';
import type { NewBlock, Place } from '../../../shared/hookEditor/hookEdits';
import {
  BUTTON,
  DECISION_CHOICES,
  EVENT_ORDER,
  EVENT_TEXT,
  FIELD_LABELS,
  PALETTE_ITEMS,
  eventTag,
  itemName,
  newBlockOf,
  paletteFitReason,
  requiredFields,
  type PaletteItem,
} from './hookEditorText';
import type { DragItem } from './hookDrops';
import { HookPicker, type PickerOption } from './HookPicker';
import { HelpTooltip } from '../../help/HelpTooltip';

const NO_TARGET_REASON = 'Pick a "When" block or an "Only when" group first.';

function idOf(item: PaletteItem): string {
  return item.kind === 'action' ? item.action : `then-${item.answer}`;
}

const WHEN_OPTIONS: readonly PickerOption[] = EVENT_ORDER.map((event) => ({
  id: event,
  name: event,
  detail: `${EVENT_TEXT[event]}. ${eventTag(event)}.`,
  words: `${event} ${EVENT_TEXT[event]}`,
}));

/** A palette block whose fields the palette is asking for, and the button that was clicked. */
export interface PaletteAsk {
  item: PaletteItem;
  anchor: Element;
}

const FIELD_BOX = 'select-text rounded border border-[var(--nim-border)] bg-[var(--nim-bg)] px-2 py-1 font-mono text-xs';

/**
 * Asks for the fields a new block needs before it is added. The anchor is the
 * button that was clicked, or the rectangle where a block was dropped.
 * `onAdd` answers with the reason when the block is refused. Then the popover
 * stays open, keeps what was typed, and shows the reason.
 */
export function AskFields({ item, anchor, onAdd, onCancel }: { item: PaletteItem; anchor: ReferenceType | null; onAdd: (block: NewBlock) => string | null; onCancel: () => void }) {
  const [values, setValues] = useState<Record<string, string>>(item.kind === 'then' && item.answer === 'permission' ? { decision: 'ask' } : {});
  const [refusal, setRefusal] = useState<string | null>(null);
  const { refs, floatingStyles, context } = useFloating({
    open: true,
    onOpenChange: (open) => !open && onCancel(),
    placement: 'right-start',
    middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 })],
  });
  // The anchor can be a dropped rectangle, not only an element, so it goes in as the position reference.
  useEffect(() => {
    refs.setPositionReference(anchor);
  }, [refs, anchor]);
  const { getFloatingProps } = useInteractions([useDismiss(context)]);
  const fields = requiredFields(item);
  const ready = fields.every((name) => (values[name] ?? '').trim() !== '');
  return (
    <FloatingPortal>
      {/* The focus moves into the popover, so Escape and typing go to it, and it goes back when the popover closes. */}
      <FloatingFocusManager context={context} modal={false} initialFocus={0}>
        <div
          ref={refs.setFloating}
          style={floatingStyles}
          {...getFloatingProps()}
          className="hook-ask-fields z-[10001] flex w-72 flex-col gap-2 rounded border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] p-3 text-sm shadow"
        >
          <strong>{itemName(item)}</strong>
          {fields.map((name) =>
            name === 'decision' ? (
              <select key={name} data-testid="hook-ask-decision" className={FIELD_BOX} value={values.decision} onChange={(event) => setValues({ ...values, decision: event.target.value })}>
                {DECISION_CHOICES.map((choice) => (
                  <option key={choice.value} value={choice.value}>
                    {choice.label}
                  </option>
                ))}
              </select>
            ) : (
              <label key={name} className="flex flex-col gap-1 text-xs">
                {FIELD_LABELS[name] ?? name}
                <textarea
                  rows={name === 'prompt' || name === 'paths' ? 3 : 1}
                  data-testid={`hook-ask-${name}`}
                  className={FIELD_BOX}
                  value={values[name] ?? ''}
                  onChange={(event) => setValues({ ...values, [name]: event.target.value })}
                />
              </label>
            ),
          )}
          {refusal !== null && (
            <p className="select-text text-xs text-[var(--nim-error)]" data-testid="hook-ask-reason">
              {refusal}
            </p>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              data-testid="hook-ask-add"
              className={`${BUTTON.primary} ${BUTTON.small}`}
              disabled={!ready}
              onClick={() => setRefusal(onAdd(newBlockOf(item, values)))}
            >
              Add
            </button>
            <button type="button" className={`${BUTTON.secondary} ${BUTTON.small}`} onClick={onCancel}>
              Cancel
            </button>
          </div>
        </div>
      </FloatingFocusManager>
    </FloatingPortal>
  );
}

/**
 * The picked block as a chip to drag onto the canvas. Only the mouse drags it.
 * The Add button next to it is the way in for the keyboard.
 */
function DragChip({ id, drag, label }: { id: string; drag: DragItem; label: string }) {
  const { attributes, listeners, setNodeRef } = useDraggable({ id, data: { drag, label } });
  return (
    <span
      ref={setNodeRef}
      {...attributes}
      tabIndex={-1}
      onPointerDown={listeners?.onPointerDown as PointerEventHandler<HTMLSpanElement> | undefined}
      data-testid={id}
      title="Drag onto the hooks"
      className="flex min-w-0 flex-1 cursor-grab items-center gap-1 rounded border border-dashed border-[var(--nim-border)] px-2 py-1 text-xs"
    >
      <MaterialSymbol icon="drag_indicator" />
      <span className="truncate">{label}</span>
    </span>
  );
}

const CARD = 'flex flex-col gap-2 rounded border border-[var(--nim-border)] p-2';

interface HookPaletteProps {
  source: SettingsSource;
  target: Place | null;
  focusSearch: boolean;
  /** The block whose fields the popover asks for. The editor keeps it, so its Escape key knows a popover is open. */
  asking: PaletteAsk | null;
  onAsk: (asking: PaletteAsk | null) => void;
  onPickWhen: (event: string) => void;
  /** Answers with the reason when the block is refused. */
  onAdd: (place: Place, block: NewBlock) => string | null;
}

export function HookPalette({ source, target, focusSearch, asking, onAsk, onPickWhen, onAdd }: HookPaletteProps) {
  const [event, setEvent] = useState<string>(EVENT_ORDER[0]);
  const [itemId, setItemId] = useState(idOf(PALETTE_ITEMS[0]));
  const whenRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusSearch) whenRef.current?.focus();
  }, [focusSearch]);

  const fitReason = (item: PaletteItem) => (target === null ? NO_TARGET_REASON : paletteFitReason(source, target.event, item));
  const item = PALETTE_ITEMS.find((each) => idOf(each) === itemId) ?? PALETTE_ITEMS[0];
  const reason = fitReason(item);
  const doOptions = PALETTE_ITEMS.map((each) => ({ id: idOf(each), name: itemName(each), detail: fitReason(each) ?? '', words: itemName(each) }));

  return (
    <div className="hook-palette flex w-64 flex-col gap-3 overflow-auto border-r border-[var(--nim-border)] p-3 text-sm">
      <section className={CARD}>
        <h3 className="text-xs text-[var(--nim-text-muted)]">When</h3>
        <HelpTooltip testId="hook-when-input" placement="right">
          <div>
            <HookPicker testId="hook-when" label="Pick an event" options={WHEN_OPTIONS} picked={event} onPick={setEvent} inputRef={whenRef} />
          </div>
        </HelpTooltip>
        <p className="select-text text-xs text-[var(--nim-text-faint)]">{WHEN_OPTIONS.find((option) => option.id === event)?.detail}</p>
        <div className="flex items-center gap-2">
          <DragChip id="hook-when-chip" drag={{ kind: 'when', event }} label={event} />
          <button type="button" data-testid="hook-when-add" className={`${BUTTON.secondary} ${BUTTON.small}`} onClick={() => onPickWhen(event)}>
            Add
          </button>
        </div>
      </section>
      <section className={CARD}>
        <h3 className="text-xs text-[var(--nim-text-muted)]">Do this</h3>
        <HelpTooltip testId="hook-do-input" placement="right">
          <div>
            <HookPicker testId="hook-do" label="Pick a block" options={doOptions} picked={idOf(item)} onPick={setItemId} />
          </div>
        </HelpTooltip>
        {reason !== null && (
          <p className="select-text text-xs text-[var(--nim-text-faint)]" data-testid="hook-do-reason">
            {reason}
          </p>
        )}
        <div className="flex items-center gap-2">
          {/* A block that does not fit here can still be dragged. The drop checks where it landed, because the reason only follows the selected group. */}
          <DragChip id="hook-do-chip" drag={{ kind: 'palette', item }} label={itemName(item)} />
          <button
            type="button"
            data-testid="hook-do-add"
            aria-disabled={reason !== null}
            className={`${BUTTON.secondary} ${BUTTON.small} ${reason === null ? '' : 'opacity-50'}`}
            onClick={(click) => reason === null && onAsk({ item, anchor: click.currentTarget })}
          >
            Add
          </button>
        </div>
      </section>
      {asking !== null && target !== null && (
        <AskFields
          item={asking.item}
          anchor={asking.anchor}
          onCancel={() => onAsk(null)}
          onAdd={(block) => {
            const reason = onAdd(target, block);
            if (reason === null) onAsk(null);
            return reason;
          }}
        />
      )}
    </div>
  );
}
