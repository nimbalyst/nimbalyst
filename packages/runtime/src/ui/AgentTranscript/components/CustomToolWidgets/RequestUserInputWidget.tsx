/**
 * RequestUserInputWidget
 *
 * Generic interactive widget for the RequestUserInput tool. Renders a list of
 * typed fields (multiSelect, singleSelect, reorder, editText, confirm) and
 * collects answers in a draft atom keyed by tool-call id. The widget reads
 * pending/completed state from `toolCall.result` (durable-prompt rules), and
 * routes submit/cancel through the InteractiveWidgetHost atom.
 *
 * One widget covers all RequestUserInput field types — adding a new field
 * type means adding one renderer here, not a new top-level widget.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAtom, useAtomValue } from 'jotai';

import {
  DndContext,
  KeyboardSensor,
  MouseSensor,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

import {
  $convertFromMarkdownString,
  $convertToMarkdownString,
  TRANSFORMERS,
} from '@lexical/markdown';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { ListItemNode, ListNode } from '@lexical/list';
import { CodeNode } from '@lexical/code';
import { LinkNode } from '@lexical/link';
import { HeadingNode, QuoteNode } from '@lexical/rich-text';
import { mergeRegister } from '@lexical/utils';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  FORMAT_TEXT_COMMAND,
  SELECTION_CHANGE_COMMAND,
  type EditorState,
  type LexicalEditor,
} from 'lexical';

import type { CustomToolWidgetProps } from './index';
import { interactiveWidgetHostAtom } from '../../../../store/atoms/interactiveWidgetHost';
import {
  clearRequestUserInputDraft,
  requestUserInputDraftAtom,
  type RequestUserInputDraft,
  type RequestUserInputFieldDraft,
} from '../../../../store/atoms/requestUserInputDraft';
import type {
  RequestUserInputAnswer,
  RequestUserInputArgs,
  RequestUserInputConfirmField,
  RequestUserInputEditTextField,
  RequestUserInputField,
  RequestUserInputMultiSelectField,
  RequestUserInputReorderField,
  RequestUserInputSingleSelectField,
} from '../../../../ai/server/providers/shared/requestUserInputTypes';

// ============================================================
// Argument / result parsing
// ============================================================

// Defense-in-depth shape check. The MCP handler validates per-type required
// arrays before forwarding to the renderer, but historical sessions persisted
// before that check landed (or replayed from another source) can still carry
// fields where e.g. a `singleSelect` is missing `options` or a `multiSelect`
// is missing `items`. Drop those silently here so the unguarded `.map`/`.filter`
// in the renderers below never throws; the user sees the remaining valid fields
// instead of a "Widget failed to render" error card.
function isValidField(field: any): field is RequestUserInputField {
  if (!field || typeof field !== 'object') return false;
  if (typeof field.id !== 'string' || typeof field.label !== 'string') return false;
  switch (field.type) {
    case 'multiSelect':
      return Array.isArray(field.items) && field.items.length > 0;
    case 'singleSelect':
      return Array.isArray(field.options) && field.options.length > 0;
    case 'reorder':
      return Array.isArray(field.items) && field.items.length > 0;
    case 'editText':
      return typeof field.initialText === 'string';
    case 'confirm':
      return true;
    default:
      return false;
  }
}

function parseArgs(args: any): RequestUserInputArgs | null {
  if (!args || typeof args !== 'object') return null;
  if (!Array.isArray(args.fields) || args.fields.length === 0) return null;
  const validFields = args.fields.filter(isValidField);
  if (validFields.length === 0) {
    console.warn('[RequestUserInputWidget] All fields dropped as malformed; skipping render');
    return null;
  }
  if (validFields.length !== args.fields.length) {
    console.warn(
      `[RequestUserInputWidget] Dropped ${args.fields.length - validFields.length} malformed field(s)`,
    );
  }
  return { ...args, fields: validFields } as RequestUserInputArgs;
}

interface ParsedResult {
  cancelled: boolean;
  answers: Record<string, RequestUserInputAnswer>;
}

function parseResult(result: unknown): ParsedResult | null {
  if (result === undefined || result === null || result === '') return null;
  return parseFromUnknown(result);
}

function parseFromUnknown(value: unknown): ParsedResult | null {
  if (value === undefined || value === null) return null;

  if (typeof value === 'string') {
    try {
      return parseFromUnknown(JSON.parse(value));
    } catch {
      const lower = value.toLowerCase();
      if (lower.includes('cancelled') || lower.includes('canceled')) {
        return { cancelled: true, answers: {} };
      }
      return null;
    }
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      if (item && typeof item === 'object' && (item as any).type === 'text' && typeof (item as any).text === 'string') {
        const nested = parseFromUnknown((item as any).text);
        if (nested) return nested;
      }
    }
    return null;
  }

  if (typeof value !== 'object') return null;

  const record = value as Record<string, unknown>;

  if (record.cancelled === true || record.canceled === true) {
    return {
      cancelled: true,
      answers: typeof record.answers === 'object' && record.answers !== null
        ? (record.answers as Record<string, RequestUserInputAnswer>)
        : {},
    };
  }

  if (record.answers && typeof record.answers === 'object' && !Array.isArray(record.answers)) {
    return {
      cancelled: false,
      answers: record.answers as Record<string, RequestUserInputAnswer>,
    };
  }

  for (const key of ['result', 'content', 'text']) {
    if (record[key] !== undefined) {
      const nested = parseFromUnknown(record[key]);
      if (nested) return nested;
    }
  }

  return null;
}

// ============================================================
// Initial-draft seeding from field defaults
// ============================================================

function seedFieldDraft(field: RequestUserInputField): RequestUserInputFieldDraft {
  switch (field.type) {
    case 'multiSelect':
      return {
        type: 'multiSelect',
        state: {
          selectedIds: field.items.filter((i) => i.defaultChecked).map((i) => i.id),
        },
      };
    case 'singleSelect':
      return {
        type: 'singleSelect',
        state: { selectedId: null, otherSelected: false, otherText: '' },
      };
    case 'reorder':
      return {
        type: 'reorder',
        state: { orderedIds: field.items.map((i) => i.id), removedIds: [] },
      };
    case 'editText':
      return {
        type: 'editText',
        state: { text: field.initialText ?? '' },
      };
    case 'confirm':
      return {
        type: 'confirm',
        state: { value: field.defaultValue ?? false },
      };
  }
}

function seedDraft(args: RequestUserInputArgs): RequestUserInputDraft {
  const fields: Record<string, RequestUserInputFieldDraft> = {};
  for (const f of args.fields) {
    fields[f.id] = seedFieldDraft(f);
  }
  return { fields, primed: true };
}

// ============================================================
// Validation - is the draft submittable?
// ============================================================

function fieldDraftValid(
  field: RequestUserInputField,
  draft: RequestUserInputFieldDraft | undefined,
): boolean {
  if (!draft) return false;
  if (draft.type !== field.type) return false;

  switch (field.type) {
    case 'multiSelect': {
      const min = field.minSelected ?? 0;
      const max = field.maxSelected ?? field.items.length;
      const count = (draft as any).state.selectedIds.length;
      return count >= min && count <= max;
    }
    case 'singleSelect': {
      const s = (draft as any).state;
      if (s.otherSelected) {
        return field.allowOther === true && typeof s.otherText === 'string' && s.otherText.trim().length > 0;
      }
      return typeof s.selectedId === 'string' && s.selectedId.length > 0;
    }
    case 'reorder': {
      const min = field.minItems ?? 0;
      return (draft as any).state.orderedIds.length >= Math.max(min, 0);
    }
    case 'editText': {
      const s = (draft as any).state;
      const trimmed = typeof s.text === 'string' ? s.text.trim() : '';
      const min = field.minLength ?? 0;
      const max = field.maxLength ?? Infinity;
      return trimmed.length >= min && (s.text?.length ?? 0) <= max;
    }
    case 'confirm':
      return true;
  }
}

function draftToAnswers(
  args: RequestUserInputArgs,
  draft: RequestUserInputDraft,
): Record<string, RequestUserInputAnswer> {
  const out: Record<string, RequestUserInputAnswer> = {};
  for (const field of args.fields) {
    const fd = draft.fields[field.id];
    if (!fd) continue;

    switch (field.type) {
      case 'multiSelect':
        if (fd.type === 'multiSelect') {
          out[field.id] = { type: 'multiSelect', selectedIds: [...fd.state.selectedIds] };
        }
        break;
      case 'singleSelect':
        if (fd.type === 'singleSelect') {
          if (fd.state.otherSelected) {
            out[field.id] = {
              type: 'singleSelect',
              selectedId: '__other__',
              otherText: fd.state.otherText.trim(),
            };
          } else if (fd.state.selectedId) {
            out[field.id] = { type: 'singleSelect', selectedId: fd.state.selectedId };
          }
        }
        break;
      case 'reorder':
        if (fd.type === 'reorder') {
          out[field.id] = {
            type: 'reorder',
            orderedIds: [...fd.state.orderedIds],
            removedIds: [...fd.state.removedIds],
          };
        }
        break;
      case 'editText':
        if (fd.type === 'editText') {
          out[field.id] = {
            type: 'editText',
            text: fd.state.text,
            edited: fd.state.text !== (field.initialText ?? ''),
          };
        }
        break;
      case 'confirm':
        if (fd.type === 'confirm') {
          out[field.id] = { type: 'confirm', value: fd.state.value };
        }
        break;
    }
  }
  return out;
}

// ============================================================
// Voice-friendliness hint (pure UI advisory; voice listener also computes
// its own copy from the same data, so this is just for display)
// ============================================================

interface VoiceHint {
  friendly: boolean;
  reason: string;
}

function computeVoiceHint(args: RequestUserInputArgs): VoiceHint {
  for (const field of args.fields) {
    if (field.type === 'reorder' && field.items.length > 6) {
      return { friendly: false, reason: `Voice will defer — too many items to reorder verbally (${field.items.length})` };
    }
    if (field.type === 'editText') {
      const len = (field.initialText ?? '').length;
      if (len > 240) {
        return { friendly: false, reason: 'Voice will defer — text too long to dictate' };
      }
    }
  }
  return { friendly: true, reason: 'Voice can read this aloud' };
}

// ============================================================
// Sub-renderers per field type
// ============================================================

interface FieldRendererProps<F extends RequestUserInputField> {
  field: F;
  draft: RequestUserInputFieldDraft;
  setDraft: (next: RequestUserInputFieldDraft) => void;
  disabled: boolean;
}

function MultiSelectRenderer({
  field,
  draft,
  setDraft,
  disabled,
}: FieldRendererProps<RequestUserInputMultiSelectField>) {
  if (draft.type !== 'multiSelect') return null;
  const selected = new Set(draft.state.selectedIds);
  const max = field.maxSelected ?? field.items.length;
  const min = field.minSelected ?? 0;

  const toggle = (id: string) => {
    if (disabled) return;
    const next = new Set(selected);
    if (next.has(id)) {
      if (next.size <= min) return;
      next.delete(id);
    } else {
      if (next.size >= max) return;
      next.add(id);
    }
    setDraft({ type: 'multiSelect', state: { selectedIds: Array.from(next) } });
  };

  return (
    <div className="flex flex-col gap-1.5" data-testid={`request-user-input-multiselect-${field.id}`}>
      {field.items.map((item) => {
        const isSelected = selected.has(item.id);
        return (
          <button
            key={item.id}
            type="button"
            data-testid="request-user-input-multiselect-row"
            data-item-id={item.id}
            data-selected={isSelected}
            onClick={() => toggle(item.id)}
            disabled={disabled}
            className={`flex items-start gap-2 py-2 px-2.5 rounded border transition-colors duration-150 cursor-pointer text-left bg-transparent disabled:opacity-50 disabled:cursor-not-allowed ${
              isSelected
                ? 'border-nim-primary bg-[color-mix(in_srgb,var(--nim-primary)_8%,var(--nim-bg-secondary))]'
                : 'border-nim bg-nim-secondary hover:bg-nim-hover'
            }`}
          >
            <span
              className={`w-4 h-4 mt-0.5 shrink-0 border rounded-sm flex items-center justify-center transition-colors ${
                isSelected ? 'bg-nim-primary border-nim-primary text-nim-on-primary' : 'bg-nim border-nim text-nim-primary'
              }`}
            >
              {isSelected && (
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                  <path d="M8.5 2.5L3.75 7.25L1.5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </span>
            <span className="flex-1 min-w-0 flex flex-col gap-0.5">
              <span className="flex items-center gap-2">
                <span className="text-[0.8125rem] font-medium text-nim leading-snug">{item.title}</span>
                {item.badge && (
                  <span className="text-[0.6875rem] font-medium px-1.5 py-0.5 rounded bg-nim-tertiary text-nim-muted">
                    {item.badge}
                  </span>
                )}
              </span>
              {item.subtitle && <span className="text-xs text-nim-muted leading-snug">{item.subtitle}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function SingleSelectRenderer({
  field,
  draft,
  setDraft,
  disabled,
}: FieldRendererProps<RequestUserInputSingleSelectField>) {
  if (draft.type !== 'singleSelect') return null;
  const otherInputRef = useRef<HTMLTextAreaElement | null>(null);

  const pick = (id: string) => {
    if (disabled) return;
    setDraft({
      type: 'singleSelect',
      state: { selectedId: id, otherSelected: false, otherText: '' },
    });
  };

  const toggleOther = () => {
    if (disabled) return;
    const next = !draft.state.otherSelected;
    setDraft({
      type: 'singleSelect',
      state: { selectedId: null, otherSelected: next, otherText: draft.state.otherText },
    });
    if (next) {
      setTimeout(() => otherInputRef.current?.focus(), 0);
    }
  };

  const setOtherText = (text: string) => {
    if (disabled) return;
    setDraft({
      type: 'singleSelect',
      state: { ...draft.state, otherText: text },
    });
  };

  return (
    <div className="flex flex-col gap-1.5" data-testid={`request-user-input-singleselect-${field.id}`}>
      {field.options.map((option) => {
        const isSelected = draft.state.selectedId === option.id;
        return (
          <button
            key={option.id}
            type="button"
            data-testid="request-user-input-singleselect-row"
            data-option-id={option.id}
            data-selected={isSelected}
            onClick={() => pick(option.id)}
            disabled={disabled}
            className={`flex items-start gap-2 py-2 px-2.5 rounded border transition-colors duration-150 cursor-pointer text-left bg-transparent disabled:opacity-50 disabled:cursor-not-allowed ${
              isSelected
                ? 'border-nim-primary bg-[color-mix(in_srgb,var(--nim-primary)_8%,var(--nim-bg-secondary))]'
                : 'border-nim bg-nim-secondary hover:bg-nim-hover'
            }`}
          >
            <span
              className={`w-4 h-4 mt-0.5 shrink-0 border rounded-full flex items-center justify-center transition-colors ${
                isSelected ? 'bg-nim-primary border-nim-primary' : 'bg-nim border-nim'
              }`}
            >
              {isSelected && <span className="w-2 h-2 rounded-full bg-white" />}
            </span>
            <span className="flex-1 min-w-0 flex flex-col gap-0.5">
              <span className="text-[0.8125rem] font-medium text-nim leading-snug">{option.label}</span>
              {option.description && <span className="text-xs text-nim-muted leading-snug">{option.description}</span>}
            </span>
          </button>
        );
      })}

      {field.allowOther && (
        <div
          data-testid="request-user-input-singleselect-other"
          data-selected={draft.state.otherSelected}
          className={`rounded border transition-colors ${
            draft.state.otherSelected
              ? 'border-nim-primary bg-[color-mix(in_srgb,var(--nim-primary)_8%,var(--nim-bg-secondary))]'
              : 'border-nim bg-nim-secondary hover:bg-nim-hover'
          } ${disabled ? 'opacity-50' : ''}`}
        >
          <button
            type="button"
            onClick={toggleOther}
            disabled={disabled}
            className="flex items-start gap-2 py-2 px-2.5 w-full cursor-pointer text-left bg-transparent disabled:cursor-not-allowed"
          >
            <span
              className={`w-4 h-4 mt-0.5 shrink-0 border rounded-full flex items-center justify-center transition-colors ${
                draft.state.otherSelected ? 'bg-nim-primary border-nim-primary' : 'bg-nim border-nim'
              }`}
            >
              {draft.state.otherSelected && <span className="w-2 h-2 rounded-full bg-white" />}
            </span>
            <span className="text-[0.8125rem] font-medium text-nim leading-snug">Other</span>
          </button>
          {draft.state.otherSelected && (
            <div className="px-2.5 pb-2">
              <textarea
                ref={(el) => { otherInputRef.current = el; }}
                data-testid="request-user-input-singleselect-other-input"
                value={draft.state.otherText}
                onChange={(e) => setOtherText(e.target.value)}
                placeholder="Type your answer..."
                disabled={disabled}
                rows={2}
                className="w-full px-2.5 py-2 rounded border border-nim bg-nim text-sm text-nim placeholder-nim-faint resize-y focus:outline-none focus:border-nim-primary disabled:opacity-50"
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface ReorderRowProps {
  itemId: string;
  index: number;
  title: string;
  subtitle?: string;
  removable: boolean;
  canRemove: boolean;
  onRemove: () => void;
  disabled: boolean;
}

function ReorderRow({ itemId, index, title, subtitle, removable, canRemove, onRemove, disabled }: ReorderRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: itemId });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  // iOS WKWebView: the long-press text-selection callout will hijack a drag
  // gesture if we let any text on the row be selectable. Keep the row's
  // touchAction permissive (so vertical scroll still works on the transcript)
  // but disable selection and the callout outright.
  const rowStyle: React.CSSProperties = {
    ...style,
    WebkitUserSelect: 'none',
    userSelect: 'none',
    WebkitTouchCallout: 'none',
  };

  return (
    <div
      ref={setNodeRef}
      style={rowStyle}
      data-testid="request-user-input-reorder-row"
      data-item-id={itemId}
      data-dragging={isDragging || undefined}
      className={`flex items-center gap-2.5 py-2 px-2.5 rounded border bg-nim-secondary ${
        isDragging ? 'border-nim-primary shadow-lg' : 'border-nim'
      }`}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        disabled={disabled}
        aria-label="Drag to reorder"
        // touch-action: none on the handle -- once the TouchSensor fires
        // (after the activation delay) the browser must NOT also try to
        // pan/scroll. Without this, iOS routes the gesture to scroll and
        // @dnd-kit cancels the drag mid-flight, snapping the row back to its
        // original position on release.
        style={{ touchAction: 'none' }}
        className="w-5 h-5 shrink-0 text-nim-faint cursor-grab disabled:cursor-not-allowed flex items-center justify-center"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <circle cx="5" cy="3" r="1" fill="currentColor" />
          <circle cx="9" cy="3" r="1" fill="currentColor" />
          <circle cx="5" cy="7" r="1" fill="currentColor" />
          <circle cx="9" cy="7" r="1" fill="currentColor" />
          <circle cx="5" cy="11" r="1" fill="currentColor" />
          <circle cx="9" cy="11" r="1" fill="currentColor" />
        </svg>
      </button>
      <div className="w-6 text-center text-xs font-semibold text-nim-muted font-mono shrink-0">{index + 1}</div>
      <div className="flex-1 min-w-0">
        <div className="text-[0.8125rem] font-medium text-nim leading-snug">{title}</div>
        {subtitle && <div className="text-xs text-nim-muted leading-snug">{subtitle}</div>}
      </div>
      {removable && (
        <button
          type="button"
          data-testid="request-user-input-reorder-remove"
          onClick={onRemove}
          disabled={disabled || !canRemove}
          aria-label="Remove item"
          className="w-6 h-6 shrink-0 rounded text-nim-faint hover:text-nim-error hover:bg-[color-mix(in_srgb,var(--nim-error)_12%,transparent)] disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M3 4h8M5 4V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1M4 4l.5 7a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1L10 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}
    </div>
  );
}

function ReorderRenderer({
  field,
  draft,
  setDraft,
  disabled,
}: FieldRendererProps<RequestUserInputReorderField>) {
  if (draft.type !== 'reorder') return null;

  // Three sensors for cross-platform support:
  //  - MouseSensor (distance) for desktop click-drag
  //  - TouchSensor (delay) for iOS/Android long-press drag. The delay is what
  //    lets us coexist with the iOS text-selection callout: short taps still
  //    select text, but ~200ms holds initiate the drag and the activation
  //    swallows the touch so the OS doesn't pop the callout.
  //  - KeyboardSensor for accessibility
  // PointerSensor is intentionally NOT used here -- on iOS WKWebView its
  // default activation conflicts with the selection callout, which cancels
  // the drag and snaps items back to their original order.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const itemsById = useMemo(() => {
    const map = new Map<string, RequestUserInputReorderField['items'][number]>();
    for (const i of field.items) map.set(i.id, i);
    return map;
  }, [field.items]);

  const min = Math.max(field.minItems ?? 0, 0);

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = draft.state.orderedIds.indexOf(String(active.id));
    const newIndex = draft.state.orderedIds.indexOf(String(over.id));
    if (oldIndex === -1 || newIndex === -1) return;
    setDraft({
      type: 'reorder',
      state: {
        orderedIds: arrayMove(draft.state.orderedIds, oldIndex, newIndex),
        removedIds: draft.state.removedIds,
      },
    });
  };

  const remove = (id: string) => {
    if (disabled) return;
    if (draft.state.orderedIds.length <= min) return;
    setDraft({
      type: 'reorder',
      state: {
        orderedIds: draft.state.orderedIds.filter((x) => x !== id),
        removedIds: [...draft.state.removedIds, id],
      },
    });
  };

  return (
    <div data-testid={`request-user-input-reorder-${field.id}`} className="flex flex-col gap-1.5">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={draft.state.orderedIds} strategy={verticalListSortingStrategy}>
          {draft.state.orderedIds.map((id, index) => {
            const item = itemsById.get(id);
            if (!item) return null;
            return (
              <ReorderRow
                key={id}
                itemId={id}
                index={index}
                title={item.title}
                subtitle={item.subtitle}
                removable={item.removable === true}
                canRemove={draft.state.orderedIds.length > min}
                onRemove={() => remove(id)}
                disabled={disabled}
              />
            );
          })}
        </SortableContext>
      </DndContext>
      {draft.state.removedIds.length > 0 && (
        <div className="text-[0.6875rem] text-nim-faint italic px-1">
          Removed: {draft.state.removedIds.length} item{draft.state.removedIds.length === 1 ? '' : 's'}
        </div>
      )}
    </div>
  );
}

// ----- editText (inline Lexical) -----

const EDIT_TEXT_NODES = [HeadingNode, QuoteNode, ListNode, ListItemNode, CodeNode, LinkNode];

const EDIT_TEXT_THEME = {
  // Minimal theme — Tailwind handles most styling. Lexical theme classes are
  // applied to inline elements (bold, italic, code) via plain class names so
  // the DOM is style-able from the widget CSS.
  paragraph: 'rui-lexical-paragraph',
  text: {
    bold: 'rui-lexical-bold',
    italic: 'rui-lexical-italic',
    code: 'rui-lexical-code',
    underline: 'rui-lexical-underline',
  },
  list: {
    ul: 'rui-lexical-ul',
    ol: 'rui-lexical-ol',
    listitem: 'rui-lexical-li',
  },
  heading: {
    h1: 'rui-lexical-h1',
    h2: 'rui-lexical-h2',
    h3: 'rui-lexical-h3',
  },
  code: 'rui-lexical-codeblock',
};

interface InlineLexicalEditorProps {
  initialText: string;
  format: 'markdown' | 'plain';
  placeholder?: string;
  onChange: (text: string) => void;
  disabled: boolean;
}

interface FormatToolbarState {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  code: boolean;
}

function FormatToolbar({ disabled }: { disabled: boolean }) {
  const [editor] = useLexicalComposerContext();
  const [state, setState] = useState<FormatToolbarState>({ bold: false, italic: false, underline: false, code: false });

  useEffect(() => {
    return mergeRegister(
      editor.registerCommand(
        SELECTION_CHANGE_COMMAND,
        () => {
          const sel = $getSelection();
          if ($isRangeSelection(sel)) {
            setState({
              bold: sel.hasFormat('bold'),
              italic: sel.hasFormat('italic'),
              underline: sel.hasFormat('underline'),
              code: sel.hasFormat('code'),
            });
          }
          return false;
        },
        1,
      ),
    );
  }, [editor]);

  const fmt = (type: 'bold' | 'italic' | 'underline' | 'code') => {
    if (disabled) return;
    editor.dispatchCommand(FORMAT_TEXT_COMMAND, type);
  };

  const baseBtn =
    'w-6 h-6 border-0 rounded text-xs cursor-pointer flex items-center justify-center text-nim-muted hover:bg-nim-hover hover:text-nim disabled:opacity-50 disabled:cursor-not-allowed';
  const activeBtn = 'bg-[color-mix(in_srgb,var(--nim-primary)_18%,transparent)] text-nim-primary';

  return (
    <div className="flex items-center gap-0.5 p-1 bg-nim-tertiary border-b border-nim">
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => fmt('bold')}
        disabled={disabled}
        className={`${baseBtn} ${state.bold ? activeBtn : ''}`}
        aria-label="Bold"
      >
        <strong>B</strong>
      </button>
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => fmt('italic')}
        disabled={disabled}
        className={`${baseBtn} ${state.italic ? activeBtn : ''}`}
        aria-label="Italic"
      >
        <em>I</em>
      </button>
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => fmt('underline')}
        disabled={disabled}
        className={`${baseBtn} ${state.underline ? activeBtn : 'underline'}`}
        aria-label="Underline"
      >
        <span style={{ textDecoration: 'underline' }}>U</span>
      </button>
      <span className="w-px h-3 bg-nim-border mx-1" />
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => fmt('code')}
        disabled={disabled}
        className={`${baseBtn} ${state.code ? activeBtn : ''}`}
        aria-label="Code"
      >
        {'<>'}
      </button>
    </div>
  );
}

function InlineLexicalEditor({ initialText, format, placeholder, onChange, disabled }: InlineLexicalEditorProps) {
  // Capture the initial text so we don't reseed the editor when the parent
  // re-renders. The editor owns its content state thereafter; the draft atom
  // mirrors it via OnChangePlugin.
  const initialTextRef = useRef(initialText);

  const initialConfig = useMemo(
    () => ({
      namespace: 'request-user-input-edittext',
      theme: EDIT_TEXT_THEME,
      nodes: EDIT_TEXT_NODES,
      editable: !disabled,
      onError: (error: Error) => {
        console.error('[RequestUserInputWidget] Lexical error:', error);
      },
      editorState: (editor: LexicalEditor) => {
        if (format === 'markdown') {
          $convertFromMarkdownString(initialTextRef.current ?? '', TRANSFORMERS);
        } else {
          // Plain text: insert as a single paragraph block
          const root = $getRoot();
          root.clear();
          if (initialTextRef.current) {
            const lines = initialTextRef.current.split('\n');
            for (const line of lines) {
              const para = $createParagraphNode();
              if (line) para.append($createTextNode(line));
              root.append(para);
            }
          }
        }
      },
    }),
    // initialConfig is captured once; subsequent rerenders shouldn't re-init
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const handleChange = useCallback(
    (state: EditorState) => {
      state.read(() => {
        let text: string;
        if (format === 'markdown') {
          text = $convertToMarkdownString(TRANSFORMERS);
        } else {
          text = $getRoot().getTextContent();
        }
        onChange(text);
      });
    },
    [format, onChange],
  );

  return (
    <div className="rui-lexical-shell border border-nim rounded bg-nim-secondary overflow-hidden">
      <LexicalComposer initialConfig={initialConfig}>
        {format === 'markdown' && <FormatToolbar disabled={disabled} />}
        <div className="relative">
          <RichTextPlugin
            contentEditable={
              <ContentEditable
                data-testid="request-user-input-edittext-content"
                className="rui-lexical-content px-3.5 py-3 min-h-[6rem] text-sm text-nim leading-relaxed outline-none"
                aria-label="Edit text"
              />
            }
            placeholder={
              placeholder ? (
                <div className="absolute top-3 left-3.5 text-sm text-nim-faint pointer-events-none select-none">
                  {placeholder}
                </div>
              ) : null
            }
            ErrorBoundary={LexicalErrorBoundary}
          />
          <HistoryPlugin />
          <OnChangePlugin onChange={handleChange} ignoreSelectionChange />
        </div>
      </LexicalComposer>
    </div>
  );
}

function EditTextRenderer({
  field,
  draft,
  setDraft,
  disabled,
}: FieldRendererProps<RequestUserInputEditTextField>) {
  if (draft.type !== 'editText') return null;
  const format = field.format ?? 'markdown';
  const initial = field.initialText ?? '';
  const charCount = draft.state.text.length;
  const edited = draft.state.text !== initial;

  const onChange = useCallback(
    (text: string) => {
      setDraft({ type: 'editText', state: { text } });
    },
    [setDraft],
  );

  return (
    <div data-testid={`request-user-input-edittext-${field.id}`}>
      <InlineLexicalEditor
        initialText={initial}
        format={format}
        placeholder={field.placeholder}
        onChange={onChange}
        disabled={disabled}
      />
      <div className="flex items-center justify-between mt-1.5 text-[0.6875rem] text-nim-faint">
        <span className={edited ? 'text-nim-warning' : ''}>{edited ? '• edited from draft' : '• unchanged'}</span>
        <span>
          {charCount} chars · {format}
          {field.maxLength ? ` · max ${field.maxLength}` : ''}
        </span>
      </div>
    </div>
  );
}

function ConfirmRenderer({
  field,
  draft,
  setDraft,
  disabled,
}: FieldRendererProps<RequestUserInputConfirmField>) {
  if (draft.type !== 'confirm') return null;
  const value = draft.state.value;

  const toggle = () => {
    if (disabled) return;
    setDraft({ type: 'confirm', state: { value: !value } });
  };

  return (
    <button
      type="button"
      data-testid={`request-user-input-confirm-${field.id}`}
      data-checked={value}
      onClick={toggle}
      disabled={disabled}
      className={`flex items-start gap-2 py-2 px-2.5 rounded border transition-colors duration-150 cursor-pointer text-left bg-transparent disabled:opacity-50 disabled:cursor-not-allowed w-full ${
        value
          ? 'border-nim-primary bg-[color-mix(in_srgb,var(--nim-primary)_8%,var(--nim-bg-secondary))]'
          : 'border-nim bg-nim-secondary hover:bg-nim-hover'
      }`}
    >
      <span
        className={`w-4 h-4 mt-0.5 shrink-0 border rounded-sm flex items-center justify-center transition-colors ${
          value ? 'bg-nim-primary border-nim-primary text-nim-on-primary' : 'bg-nim border-nim text-nim-primary'
        }`}
      >
        {value && (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <path d="M8.5 2.5L3.75 7.25L1.5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </span>
      <span className="text-[0.8125rem] font-medium text-nim leading-snug">{value ? 'Yes' : 'No'}</span>
    </button>
  );
}

// ============================================================
// Field card (header + renderer per field)
// ============================================================

function FieldCard({
  field,
  draft,
  setDraft,
  disabled,
}: {
  field: RequestUserInputField;
  draft: RequestUserInputFieldDraft;
  setDraft: (next: RequestUserInputFieldDraft) => void;
  disabled: boolean;
}) {
  const helper = (() => {
    switch (field.type) {
      case 'multiSelect': {
        const min = field.minSelected ?? 0;
        const max = field.maxSelected ?? field.items.length;
        if (min > 0 && max < field.items.length) return `Pick ${min}-${max}`;
        if (min > 0) return `Pick at least ${min}`;
        if (max < field.items.length) return `Pick up to ${max}`;
        return 'Pick any subset';
      }
      case 'singleSelect':
        return field.allowOther ? 'Pick one or write your own' : 'Pick one';
      case 'reorder':
        return field.minItems
          ? `${field.items.length} items · minimum ${field.minItems}`
          : `${field.items.length} items`;
      case 'editText':
        return field.format === 'plain' ? 'Plain text' : 'Markdown supported';
      case 'confirm':
        return undefined;
    }
  })();

  return (
    <div className="bg-nim border border-nim rounded-md p-3 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-[0.6875rem] font-semibold uppercase tracking-wide text-nim-primary bg-[color-mix(in_srgb,var(--nim-primary)_12%,transparent)] py-0.5 px-2 rounded-full">
          {field.label}
        </span>
        {helper && <span className="text-[0.6875rem] text-nim-faint italic">{helper}</span>}
      </div>
      {field.description && <div className="text-xs text-nim-muted leading-snug">{field.description}</div>}
      {field.type === 'multiSelect' && (
        <MultiSelectRenderer field={field} draft={draft} setDraft={setDraft} disabled={disabled} />
      )}
      {field.type === 'singleSelect' && (
        <SingleSelectRenderer field={field} draft={draft} setDraft={setDraft} disabled={disabled} />
      )}
      {field.type === 'reorder' && (
        <ReorderRenderer field={field} draft={draft} setDraft={setDraft} disabled={disabled} />
      )}
      {field.type === 'editText' && (
        <EditTextRenderer field={field} draft={draft} setDraft={setDraft} disabled={disabled} />
      )}
      {field.type === 'confirm' && (
        <ConfirmRenderer field={field} draft={draft} setDraft={setDraft} disabled={disabled} />
      )}
    </div>
  );
}

// ============================================================
// Main widget component
// ============================================================

export const RequestUserInputWidget: React.FC<CustomToolWidgetProps> = ({ message, sessionId }) => {
  const toolCall = message.toolCall;
  const promptId = toolCall?.providerToolCallId || '';

  if (!toolCall || !promptId) {
    if (toolCall && !promptId) {
      console.warn('[RequestUserInputWidget] missing providerToolCallId; skipping render');
    }
    return null;
  }

  const host = useAtomValue(interactiveWidgetHostAtom(sessionId));
  const args = parseArgs(toolCall.arguments);

  const rawResult = toolCall.result;
  const parsedResult = useMemo(() => parseResult(rawResult), [rawResult]);
  const isCompleted = parsedResult !== null;
  const isCancelled = parsedResult?.cancelled === true;
  const isPending = !isCompleted;

  const [draft, setDraft] = useAtom(requestUserInputDraftAtom(promptId));

  // Prime the draft on first mount.
  const primedRef = useRef(false);
  useEffect(() => {
    if (primedRef.current) return;
    if (!args) return;
    if (draft.primed) {
      primedRef.current = true;
      return;
    }
    setDraft(seedDraft(args));
    primedRef.current = true;
  }, [args, draft.primed, setDraft]);

  const setFieldDraft = useCallback(
    (fieldId: string, next: RequestUserInputFieldDraft) => {
      setDraft((prev) => ({
        ...prev,
        primed: true,
        fields: { ...prev.fields, [fieldId]: next },
      }));
    },
    [setDraft],
  );

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [hasResponded, setHasResponded] = useState(false);
  const [localResult, setLocalResult] = useState<{ answers: Record<string, RequestUserInputAnswer>; cancelled?: boolean } | null>(null);

  const allValid = useMemo(() => {
    if (!args) return false;
    return args.fields.every((f) => fieldDraftValid(f, draft.fields[f.id]));
  }, [args, draft.fields]);

  const handleSubmit = useCallback(async () => {
    if (!host || !args || hasResponded || !isPending || !allValid) return;
    const answers = draftToAnswers(args, draft);
    setIsSubmitting(true);
    setLocalResult({ answers });
    setHasResponded(true);
    try {
      await host.requestUserInputSubmit(promptId, answers);
      clearRequestUserInputDraft(promptId);
    } catch (error) {
      console.error('[RequestUserInputWidget] Failed to submit:', error);
      setLocalResult(null);
      setHasResponded(false);
    } finally {
      setIsSubmitting(false);
    }
  }, [host, args, draft, promptId, hasResponded, isPending, allValid]);

  const handleCancel = useCallback(async () => {
    if (!host || hasResponded || !isPending) return;
    setIsSubmitting(true);
    setLocalResult({ answers: {}, cancelled: true });
    setHasResponded(true);
    try {
      await host.requestUserInputCancel(promptId);
      clearRequestUserInputDraft(promptId);
    } catch (error) {
      console.error('[RequestUserInputWidget] Failed to cancel:', error);
    } finally {
      setIsSubmitting(false);
    }
  }, [host, promptId, hasResponded, isPending]);

  if (!args) return null;

  const displayResult = localResult || (isCompleted && parsedResult ? parsedResult : null);
  const displayCancelled = displayResult?.cancelled === true;

  const voiceHint = computeVoiceHint(args);

  // ---- Completed state ----
  if (displayResult || hasResponded) {
    const statusText = displayCancelled ? 'Input Cancelled' : 'Input Submitted';

    return (
      <div
        data-testid="request-user-input-widget"
        data-state={displayCancelled ? 'cancelled' : 'completed'}
        className="request-user-input-widget rounded-lg bg-nim-secondary border border-nim overflow-hidden opacity-85"
      >
        <div className="flex items-center gap-2 py-3 px-4 border-b border-nim bg-nim-tertiary">
          <RequestUserInputIcon />
          <span className="text-sm font-semibold text-nim flex-1">{args.title || statusText}</span>
          {!displayCancelled && (
            <span
              data-testid="request-user-input-completed"
              className="flex items-center gap-1 text-xs font-medium text-nim-success py-1 px-2 bg-[color-mix(in_srgb,var(--nim-success)_12%,transparent)] rounded-full"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M10 3L4.5 8.5L2 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Submitted
            </span>
          )}
          {displayCancelled && (
            <span
              data-testid="request-user-input-cancelled"
              className="flex items-center gap-1 text-xs font-medium text-nim-muted py-1 px-2 bg-nim-tertiary rounded-full"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M9 3L3 9M3 3l6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Cancelled
            </span>
          )}
        </div>
        <div className="p-3 flex flex-col gap-2">
          {args.intro && <div className="text-sm text-nim-muted">{args.intro}</div>}
          <CompletedSummary fields={args.fields} answers={displayResult?.answers ?? {}} cancelled={displayCancelled} />
        </div>
      </div>
    );
  }

  // ---- Pending state, no host ----
  if (!host) {
    return (
      <div
        data-testid="request-user-input-widget"
        data-state="pending"
        className="request-user-input-widget rounded-lg bg-nim-secondary border border-nim-primary overflow-hidden"
      >
        <div className="flex items-center gap-2 py-3 px-4 bg-nim-tertiary">
          <RequestUserInputIcon />
          <span className="text-sm font-semibold text-nim flex-1">{args.title || 'Input requested'}</span>
          <span data-testid="request-user-input-pending" className="text-xs text-nim-muted">
            Waiting...
          </span>
        </div>
      </div>
    );
  }

  // ---- Pending interactive state ----
  return (
    <div
      data-testid="request-user-input-widget"
      data-state="pending"
      className="request-user-input-widget rounded-lg bg-nim-secondary border border-nim-primary overflow-hidden"
    >
      <div className="flex items-center gap-2 py-3 px-4 border-b border-nim bg-nim-tertiary">
        <RequestUserInputIcon />
        <span className="text-sm font-semibold text-nim flex-1">{args.title || 'Input requested'}</span>
        <span className="text-[0.6875rem] font-semibold uppercase tracking-wide text-nim-primary bg-[color-mix(in_srgb,var(--nim-primary)_14%,transparent)] py-0.5 px-2 rounded-full">
          Input requested
        </span>
      </div>

      <div className="p-3 flex flex-col gap-3">
        {args.intro && <div className="text-sm text-nim leading-snug">{args.intro}</div>}

        {args.fields.map((field) => {
          const fd = draft.fields[field.id];
          if (!fd) return null;
          return (
            <FieldCard
              key={field.id}
              field={field}
              draft={fd}
              setDraft={(next) => setFieldDraft(field.id, next)}
              disabled={isSubmitting}
            />
          );
        })}

        <div className="flex items-center justify-between gap-2 pt-2 border-t border-nim">
          <div
            className={`flex items-center gap-1.5 text-[0.6875rem] ${
              voiceHint.friendly ? 'text-nim-faint' : 'text-nim-warning'
            }`}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M6 1v8M3 4v2M9 4v2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
            <span>{voiceHint.reason}</span>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              data-testid="request-user-input-cancel"
              onClick={handleCancel}
              disabled={isSubmitting}
              className="px-3 py-1.5 rounded-md text-[13px] cursor-pointer border border-nim transition-colors duration-150 hover:bg-nim-hover bg-nim-tertiary text-nim-muted disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {args.cancelLabel ?? 'Cancel'}
            </button>
            <button
              type="button"
              data-testid="request-user-input-submit"
              onClick={handleSubmit}
              disabled={!allValid || isSubmitting}
              className="px-4 py-1.5 rounded-md text-[13px] font-medium cursor-pointer border-none transition-colors duration-150 hover:opacity-90 bg-nim-primary text-nim-on-primary disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSubmitting ? 'Submitting...' : args.submitLabel ?? 'Confirm'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

function RequestUserInputIcon() {
  return (
    <span className="w-5 h-5 text-nim-primary shrink-0 flex items-center justify-center">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M3 4h10M3 8h10M3 12h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    </span>
  );
}

function CompletedSummary({
  fields,
  answers,
  cancelled,
}: {
  fields: RequestUserInputField[];
  answers: Record<string, RequestUserInputAnswer>;
  cancelled: boolean;
}) {
  if (cancelled) {
    return <div className="text-xs text-nim-muted italic">User cancelled the request.</div>;
  }
  return (
    <div className="flex flex-col gap-2">
      {fields.map((field) => {
        const ans = answers[field.id];
        return (
          <div key={field.id} className="bg-nim border border-nim rounded-md p-2.5">
            <div className="text-[0.6875rem] font-semibold uppercase tracking-wide text-nim-primary mb-1">
              {field.label}
            </div>
            <SummaryAnswer field={field} answer={ans} />
          </div>
        );
      })}
    </div>
  );
}

function SummaryAnswer({ field, answer }: { field: RequestUserInputField; answer: RequestUserInputAnswer | undefined }) {
  if (!answer) {
    return <div className="text-xs text-nim-faint italic">No answer recorded</div>;
  }

  switch (field.type) {
    case 'multiSelect': {
      if (answer.type !== 'multiSelect') return null;
      const titles = answer.selectedIds
        .map((id) => field.items.find((i) => i.id === id)?.title ?? id)
        .join(', ');
      return <div className="text-xs text-nim">{titles || '(none selected)'}</div>;
    }
    case 'singleSelect': {
      if (answer.type !== 'singleSelect') return null;
      if (answer.selectedId === '__other__') {
        return <div className="text-xs text-nim italic">{answer.otherText || '(empty)'}</div>;
      }
      const opt = field.options.find((o) => o.id === answer.selectedId);
      return <div className="text-xs text-nim">{opt?.label ?? answer.selectedId}</div>;
    }
    case 'reorder': {
      if (answer.type !== 'reorder') return null;
      // Sized for up to 3-digit indices. For lists this size we'd be in voice-
      // unfriendly territory anyway -- voice defers to the screen by then.
      const total = answer.orderedIds.length;
      const gutterClass =
        total >= 100 ? 'w-9' : total >= 10 ? 'w-7' : 'w-5';
      return (
        <div className="flex flex-col gap-1">
          <ol className="flex flex-col gap-1 m-0 p-0 list-none">
            {answer.orderedIds.map((id, idx) => {
              const item = field.items.find((i) => i.id === id);
              return (
                <li key={id} className="flex items-baseline gap-2 text-xs text-nim">
                  <span
                    className={`${gutterClass} shrink-0 text-right font-mono text-nim-muted whitespace-nowrap tabular-nums`}
                  >
                    {idx + 1}.
                  </span>
                  <span className="min-w-0 break-words">{item?.title ?? id}</span>
                </li>
              );
            })}
          </ol>
          {answer.removedIds.length > 0 && (
            <div className="text-[0.6875rem] text-nim-faint italic">
              Removed: {answer.removedIds.length} item{answer.removedIds.length === 1 ? '' : 's'}
            </div>
          )}
        </div>
      );
    }
    case 'editText': {
      if (answer.type !== 'editText') return null;
      return (
        <div className="flex flex-col gap-1">
          <pre className="text-xs text-nim font-mono whitespace-pre-wrap break-words">
            {answer.text}
          </pre>
          {answer.edited && <div className="text-[0.6875rem] text-nim-warning italic">edited from draft</div>}
        </div>
      );
    }
    case 'confirm': {
      if (answer.type !== 'confirm') return null;
      return <div className="text-xs text-nim">{answer.value ? 'Yes' : 'No'}</div>;
    }
  }
}
