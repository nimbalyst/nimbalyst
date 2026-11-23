/**
 * The blocks: one "When" block per event, an "Only when" block per group, and
 * the hooks inside. Clicking a hook opens its form. Nothing here keeps hook
 * data; every change goes up as one edit.
 */

import { useDndContext, useDroppable } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useEffect, useState, type ReactNode } from 'react';

import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';

import { readBlocks, type EventBlock, type GroupBlock, type HookBlock, type HookDocument, type HookKey } from '../../../shared/hookEditor/hookDocument';
import type { HookEdit, Place } from '../../../shared/hookEditor/hookEdits';
import type { HookSourceKind } from '../../../shared/hookEditor/types';
import { HookBlockForm } from './HookBlockForm';
import type { DragItem } from './hookDrops';
import { BLOCK_COLOURS, BUTTON, EVENT_TEXT, blockName, chipChoices, chipsOf, eventTag, foldedSummary, inEventOrder, matcherOfChips } from './hookEditorText';

interface HookCanvasProps {
  document: HookDocument;
  selectedId: string | null;
  pendingWhen: Place | null;
  onSelect: (id: string | null) => void;
  onEdit: (edit: HookEdit) => void;
  onDelete: (key: HookKey) => void;
  onPause: (key: HookKey) => void;
}

function OnlyWhen({ group, onEdit }: { group: GroupBlock; onEdit: (edit: HookEdit) => void }) {
  const choices = chipChoices(group.event);
  // What is typed in the box until the user leaves it. Null means the box shows the file's matcher.
  const [draft, setDraft] = useState<string | null>(null);
  if (choices === null) return <span className="text-xs text-[var(--nim-text-faint)]">Runs every time</span>;
  const chips = chipsOf(group.matcher, choices);
  const setMatcher = (matcher: string | null) => onEdit({ kind: 'setMatcher', event: group.event, groupIndex: group.groupIndex, matcher });
  if (choices.length > 0 && chips !== null) {
    return (
      <div className="flex flex-wrap gap-1">
        {choices.map((chip) => {
          const on = chips.includes(chip);
          return (
            <button
              key={chip}
              type="button"
              data-testid={`hook-chip-${group.id}-${chip}`}
              className={on ? 'rounded bg-[var(--nim-info)] px-2 text-xs text-[var(--nim-bg)]' : 'rounded border border-[var(--nim-border)] px-2 text-xs'}
              onClick={() => setMatcher(matcherOfChips(on ? chips.filter((other) => other !== chip) : [...chips, chip]))}
            >
              {chip}
            </button>
          );
        })}
      </div>
    );
  }
  return (
    <input
      data-testid={`hook-matcher-${group.id}`}
      className="select-text rounded border border-[var(--nim-border)] bg-[var(--nim-bg)] px-2 font-mono text-xs"
      value={draft ?? group.matcher ?? ''}
      placeholder="Any"
      onChange={(event) => setDraft(event.target.value)}
      // Spaces around the text are dropped. A blank box means no matcher, never an empty one.
      // A matcher that ends up the same as the file's adds no Undo step. The box then shows the file's matcher.
      onBlur={() => {
        if (draft !== null) {
          const next = draft.trim() === '' ? null : draft.trim();
          if (next !== (group.matcher ?? null)) setMatcher(next);
        }
        setDraft(null);
      }}
    />
  );
}

/** A drop strip is thin until a drag starts. Then it is at least one line of text high, so it is easy to hit. */
function stripClass(name: string, dragging: boolean): string {
  const size = dragging ? 'min-h-6 rounded border border-dashed border-[var(--nim-border)]' : 'min-h-2';
  return `${name} ${size} text-center text-xs text-[var(--nim-text-faint)]`;
}

/** A thin strip at the end of a group. Drop a hook or a palette block here to add it last. */
function GroupEnd({ group }: { group: GroupBlock }) {
  const { setNodeRef, isOver, active } = useDroppable({
    id: `${group.id}/end`,
    data: { target: { event: group.event, matcher: group.matcher, groupIndex: group.groupIndex, index: null } },
  });
  return (
    <div ref={setNodeRef} className={stripClass('hook-group-end', active !== null)} data-testid={`hook-group-end-${group.id}`}>
      {isOver && 'Drop here to add at the end'}
    </div>
  );
}

/** A strip under an event. Drop a hook or a palette block here to start a new "Only when" group. */
function NewGroup({ event }: { event: string }) {
  const { setNodeRef, isOver, active } = useDroppable({
    id: `${event}/new-group`,
    data: { target: { event, matcher: null, groupIndex: null, index: null } },
  });
  return (
    <div ref={setNodeRef} className={stripClass('hook-new-group', active !== null)} data-testid={`hook-new-group-${event}`}>
      {isOver && "Drop here for a new 'Only when' group"}
    </div>
  );
}

interface HookRowProps {
  group: GroupBlock;
  source: HookSourceKind;
  block: HookBlock;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onEdit: (edit: HookEdit) => void;
  onDelete: (key: HookKey) => void;
  onPause: (key: HookKey) => void;
}

/** One hook inside a group. Only the grip at the left drags, so the form fields keep working. */
function HookRow({ group, source, block, selectedId, onSelect, onEdit, onDelete, onPause }: HookRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: block.id,
    data: {
      drag: { kind: 'hook', key: block.key },
      label: blockName(block),
      target: { event: group.event, matcher: group.matcher, groupIndex: group.groupIndex, index: block.key.hookIndex },
    },
    disabled: block.kind === 'opaque',
  });
  return (
    <div
      ref={setNodeRef}
      data-testid={`hook-block-${block.id}`}
      className={selectedId === block.id ? 'my-1 rounded border-l-4 bg-[var(--nim-bg-selected)]' : 'my-1 rounded border-l-4 bg-[var(--nim-bg)]'}
      // While it is dragged, the hook fades. Its name follows the pointer instead.
      style={{ transform: CSS.Transform.toString(transform), transition, borderColor: BLOCK_COLOURS[block.kind], opacity: isDragging ? 0.4 : undefined }}
    >
      <div
        className="flex items-center gap-2 p-2 text-sm"
        onClick={() => block.kind !== 'opaque' && onSelect(block.id)}
        // Enter or Space on the hook row opens its form, as a click does. Keys on the buttons inside the row stay with them.
        role={block.kind === 'opaque' ? undefined : 'button'}
        tabIndex={block.kind === 'opaque' ? undefined : 0}
        aria-label={block.kind === 'opaque' ? undefined : `Open ${blockName(block)}`}
        onKeyDown={(key) => {
          if (block.kind === 'opaque' || key.target !== key.currentTarget || (key.key !== 'Enter' && key.key !== ' ')) return;
          key.preventDefault();
          onSelect(block.id);
        }}
      >
        {block.kind !== 'opaque' && (
          <span className="cursor-grab" title="Drag to move" data-testid={`hook-grip-${block.id}`} {...attributes} {...listeners} onClick={(click) => click.stopPropagation()}>
            <MaterialSymbol icon="drag_indicator" />
          </span>
        )}
        <span className="flex-1">{blockName(block)}</span>
        {block.kind === 'action' &&
          block.extraFields.map((field) => (
            <span key={field} className="rounded bg-[var(--nim-bg-tertiary)] px-1 text-xs" title="Kept as it is">
              {field}
            </span>
          ))}
        {block.kind !== 'opaque' && (
          <>
            <button
              type="button"
              data-testid={`hook-copy-${block.id}`}
              className={`${BUTTON.ghost} ${BUTTON.small}`}
              title="Copy"
              onClick={(click) => {
                click.stopPropagation();
                onEdit({ kind: 'copy', key: block.key, to: { event: group.event, matcher: group.matcher, groupIndex: group.groupIndex } });
              }}
            >
              Copy
            </button>
            <button
              type="button"
              data-testid={`hook-pause-${block.id}`}
              className={`${BUTTON.ghost} ${BUTTON.small}`}
              title="Pause: take it out of the file for now"
              onClick={(click) => {
                click.stopPropagation();
                onPause(block.key);
              }}
            >
              Pause
            </button>
            <button
              type="button"
              data-testid={`hook-delete-${block.id}`}
              className={`${BUTTON.ghost} ${BUTTON.small}`}
              title="Delete"
              onClick={(click) => {
                click.stopPropagation();
                onDelete(block.key);
              }}
            >
              Delete
            </button>
          </>
        )}
      </div>
      {block.kind === 'opaque' && (
        <div className="px-2 pb-2 text-xs">
          <p className="select-text text-[var(--nim-text-muted)]">{block.reason}</p>
          <pre className="select-text overflow-auto font-mono">{JSON.stringify(block.raw, null, 2)}</pre>
        </div>
      )}
      {selectedId === block.id && block.kind !== 'opaque' && <HookBlockForm key={block.id} block={block} source={source} onEdit={onEdit} />}
    </div>
  );
}

/**
 * The whole canvas takes a dropped "When" chip. The area turns on only during a
 * "When" drag, so other drags still land on the strips inside it.
 */
export function WhenDropArea({ children }: { children: ReactNode }) {
  const { active } = useDndContext();
  const whenDrag = (active?.data.current?.drag as DragItem | undefined)?.kind === 'when';
  const { setNodeRef, isOver } = useDroppable({ id: 'hook-canvas-when', disabled: !whenDrag });
  return (
    <div
      ref={setNodeRef}
      data-testid="hook-canvas-when-drop"
      className={isOver ? 'hook-when-drop min-w-0 flex-1 overflow-auto outline-dashed outline-2 outline-[var(--nim-primary)]' : 'hook-when-drop min-w-0 flex-1 overflow-auto'}
    >
      {children}
    </div>
  );
}

export function HookCanvas({ document, selectedId, pendingWhen, onSelect, onEdit, onDelete, onPause }: HookCanvasProps) {
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  // When a block inside a folded event gets selected (a new hook, for example), the event opens so its form shows.
  useEffect(() => {
    const event = selectedId?.split('/')[0];
    if (event !== undefined) setFolded((old) => (old.has(event) ? new Set([...old].filter((other) => other !== event)) : old));
  }, [selectedId]);
  const events = readBlocks(document);
  // Events are drawn in the palette order. This changes only what is shown. The file and the block ids keep their own order.
  // A picked event with no hooks yet takes its own slot in that order, not the top.
  const waiting = pendingWhen !== null && !events.some((event) => event.event === pendingWhen.event) ? pendingWhen : null;
  const rows = inEventOrder<{ event: string; block: EventBlock | null }>([
    ...events.map((block) => ({ event: block.event, block })),
    ...(waiting === null ? [] : [{ event: waiting.event, block: null }]),
  ]);
  const toggle = (id: string) => setFolded((old) => (old.has(id) ? new Set([...old].filter((other) => other !== id)) : new Set([...old, id])));

  return (
    <div className="hook-canvas flex flex-col gap-3 p-4">
      {events.length === 0 && pendingWhen === null && (
        <p className="text-sm text-[var(--nim-text-muted)]">This file has no hooks yet. Pick an event in the "When" card and click Add, or drag its chip here.</p>
      )}
      {rows.map((row) => {
        if (row.block === null) {
          return (
            <div key={`waiting-${row.event}`} className="select-text rounded border-l-4 bg-[var(--nim-bg-secondary)] p-3 text-sm" style={{ borderColor: BLOCK_COLOURS.when }}>
              <strong>{row.event}</strong> {EVENT_TEXT[row.event as keyof typeof EVENT_TEXT]}
              <p className="text-xs text-[var(--nim-text-muted)]">Pick an action in the "Do this" card. The hook is written with its first action.</p>
            </div>
          );
        }
        const event = row.block;
        return (
          <section key={event.id} data-testid={`hook-event-${event.event}`} className="rounded border-l-4 bg-[var(--nim-bg-secondary)]" style={{ borderColor: BLOCK_COLOURS.when }}>
            <header className="flex items-center gap-2 p-2">
              <button
                type="button"
                className={`${BUTTON.ghost} ${BUTTON.small}`}
                aria-label={folded.has(event.id) ? `Show the ${event.event} hooks` : `Hide the ${event.event} hooks`}
                aria-expanded={!folded.has(event.id)}
                onClick={() => toggle(event.id)}
              >
                {folded.has(event.id) ? '+' : '-'}
              </button>
              <strong>{event.event}</strong>
              <span className="text-xs text-[var(--nim-text-muted)]">{EVENT_TEXT[event.event as keyof typeof EVENT_TEXT] ?? ''}</span>
              <span className="rounded bg-[var(--nim-bg-tertiary)] px-1 text-xs">{eventTag(event.event)}</span>
              {folded.has(event.id) && <span className="ml-auto text-xs text-[var(--nim-text-faint)]">{foldedSummary(event)}</span>}
            </header>
            {event.readOnlyReason !== null && <p className="select-text px-2 pb-2 text-xs text-[var(--nim-text-muted)]">{event.readOnlyReason}</p>}
            {!folded.has(event.id) &&
              event.groups.map((group) => (
                <div
                  key={group.id}
                  data-testid={`hook-group-${group.id}`}
                  className={selectedId === group.id ? 'm-2 rounded border-l-4 bg-[var(--nim-bg-selected)] p-2' : 'm-2 rounded border-l-4 p-2'}
                  style={{ borderColor: BLOCK_COLOURS.onlyWhen }}
                  onClick={(click) => {
                    const target = click.target as Element;
                    // A click on the group's empty space or the "Only when" words selects the group.
                    // A click on a chip or the matcher box is an edit, so the open hook stays selected.
                    const onRow = target.closest('.hook-only-when') !== null && target.closest('button, input') === null;
                    if (click.target === click.currentTarget || onRow) onSelect(group.id);
                  }}
                >
                  {group.readOnlyReason !== null && <p className="select-text pb-1 text-xs text-[var(--nim-text-muted)]">{group.readOnlyReason}</p>}
                  <div className="hook-only-when flex items-center gap-2 pb-1 text-xs">
                    <span className="text-[var(--nim-text-muted)]">Only when</span>
                    <OnlyWhen group={group} onEdit={onEdit} />
                  </div>
                  <SortableContext items={group.hooks.map((block) => block.id)} strategy={verticalListSortingStrategy}>
                    {group.hooks.map((block) => (
                      <HookRow key={block.id} group={group} source={document.source} block={block} selectedId={selectedId} onSelect={onSelect} onEdit={onEdit} onDelete={onDelete} onPause={onPause} />
                    ))}
                  </SortableContext>
                  {group.readOnlyReason === null && <GroupEnd group={group} />}
                </div>
              ))}
            {!folded.has(event.id) && <NewGroup event={event.event} />}
          </section>
        );
      })}
    </div>
  );
}
