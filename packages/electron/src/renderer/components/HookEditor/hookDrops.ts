/**
 * What a drop means. A hook dropped in a new place is one move edit; a block
 * dragged from the palette first asks for the fields it needs. The index is
 * the hook's position after the move, the way dnd-kit's arrayMove counts.
 */

import type { SettingsSource } from '../../../main/services/hookEditor/hookFiles';
import type { HookKey } from '../../../shared/hookEditor/hookDocument';
import type { HookEdit, Place } from '../../../shared/hookEditor/hookEdits';
import { paletteFitReason, type PaletteItem } from './hookEditorText';

/** A "when" chip starts a new hook on its event wherever it lands, so it needs no drop place. */
export type DragItem = { kind: 'hook'; key: HookKey } | { kind: 'palette'; item: PaletteItem } | { kind: 'when'; event: string };

/** Where a drop landed. Null group index: a new group. Null index: the end of the group. */
export interface DropTarget {
  event: string;
  matcher: string | null;
  groupIndex: number | null;
  index: number | null;
}

export type DropResult = { kind: 'edit'; edit: HookEdit } | { kind: 'askFields'; item: PaletteItem; place: Place } | { kind: 'refused'; reason: string } | { kind: 'none' };

export function dropEdit(drag: Exclude<DragItem, { kind: 'when' }>, target: DropTarget, source: SettingsSource): DropResult {
  const place: Place = { event: target.event, matcher: target.matcher };
  if (target.groupIndex !== null) place.groupIndex = target.groupIndex;
  if (target.index !== null) place.index = target.index;
  if (drag.kind === 'palette') {
    // A palette block can be dragged anywhere, so check it against the event it landed on.
    const reason = paletteFitReason(source, target.event, drag.item);
    return reason === null ? { kind: 'askFields', item: drag.item, place } : { kind: 'refused', reason };
  }
  const { key } = drag;
  if (key.event === target.event && key.groupIndex === target.groupIndex && key.hookIndex === target.index) return { kind: 'none' };
  return { kind: 'edit', edit: { kind: 'move', key, to: place } };
}
