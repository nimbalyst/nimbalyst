/**
 * "Move to..." for the one page tree: pick the page or typed page a page,
 * type or typed page should live under, root, or (typed pages only) back
 * under its type. Destinations come from the tree as shown, and one that
 * would put the row inside itself (also through a type) is not offered.
 * Lazy-loaded by the sidebar so it stays out of the docs-ui eager bundle.
 */
import React, { useMemo, useState } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import type { CollabTreeNode } from '@nimbalyst/collab-client/docs';
import { treeMoveRefused, type PageTreeDestination } from '../docs/collabPageTree';
import { UNDER_TYPE } from './CollabTypeTreeRows';

/** A destination: a page or typed page row id, null for root, or `UNDER_TYPE`. */
export type CollabMoveDestination = string | null;

export interface CollabPageMoveDialogProps {
  name: string;
  tree: CollabTreeNode[];
  /** The row being moved (`document:`, `type:` or `item:` id). */
  movingNodeId: string;
  rootLabel: string;
  /** Typed pages only: label for the "under its type" destination. */
  underTypeLabel?: string;
  onConfirm: (destination: PageTreeDestination) => void;
  onCancel: () => void;
}

interface Option { id: CollabMoveDestination; name: string; depth: number; icon: string; hint?: string }

/** Where the row sits now, as a destination. */
function currentDestination(tree: CollabTreeNode[], movingNodeId: string): CollabMoveDestination {
  const find = (nodes: CollabTreeNode[], parent: CollabTreeNode | null): CollabTreeNode | null | undefined => {
    for (const node of nodes) {
      if (node.id === movingNodeId) return parent;
      const found = 'children' in node && node.children ? find(node.children, node) : undefined;
      if (found !== undefined) return found;
    }
    return undefined;
  };
  const parent = find(tree, null) ?? null;
  return parent?.type === 'type' ? UNDER_TYPE : parent?.id ?? null;
}

export default function CollabPageMoveDialog({
  name,
  tree,
  movingNodeId,
  rootLabel,
  underTypeLabel,
  onConfirm,
  onCancel,
}: CollabPageMoveDialogProps) {
  const current = useMemo(() => currentDestination(tree, movingNodeId), [movingNodeId, tree]);
  const [selected, setSelected] = useState<CollabMoveDestination>(current);
  const options = useMemo(() => {
    const list: Option[] = [];
    if (underTypeLabel && !treeMoveRefused(tree, movingNodeId, { underOwnType: true })) {
      list.push({ id: UNDER_TYPE, name: underTypeLabel, depth: 0, icon: 'table' });
    }
    list.push({ id: null, name: rootLabel, depth: 0, icon: 'workspaces' });
    const walk = (nodes: CollabTreeNode[], depth: number) => {
      for (const node of nodes) {
        const destination = node.type === 'document' || node.type === 'item';
        if (destination && !treeMoveRefused(tree, movingNodeId, { nodeId: node.id })) {
          list.push({
            id: node.id,
            name: node.name,
            depth,
            icon: 'description',
            ...(node.type === 'item' && node.typeLabel ? { hint: node.typeLabel } : {}),
          });
        }
        if ('children' in node && node.children) walk(node.children, depth + 1);
      }
    };
    walk(tree, 1);
    return list;
  }, [movingNodeId, rootLabel, tree, underTypeLabel]);
  return (
    <div
      className="collab-page-move-overlay fixed inset-0 z-[10000] flex items-center justify-center bg-black/60"
      onClick={(event) => { if (event.target === event.currentTarget) onCancel(); }}
    >
      <div
        className="collab-page-move-dialog w-[420px] max-w-[92%] bg-[var(--nim-bg)] border border-[var(--nim-border)] rounded-xl shadow-2xl overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-label={`Move ${name}`}
        onKeyDown={(event) => { if (event.key === 'Escape') onCancel(); }}
      >
        <h2 className="m-0 px-5 pt-4 pb-3 border-b border-[var(--nim-border)] text-[14px] font-semibold text-[var(--nim-text)] truncate">
          Move “{name}”
        </h2>
        <div
          className="nim-scrollbar m-4 max-h-[260px] overflow-y-auto rounded-md border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] p-1"
          role="listbox"
          aria-label="Destination page"
        >
          {options.map((option) => {
            const isSelected = option.id === selected;
            const rowId = option.id === null ? 'root' : option.id.slice(option.id.indexOf(':') + 1);
            return (
              <div
                key={option.id ?? 'root'}
                role="option"
                aria-selected={isSelected}
                tabIndex={0}
                className={`collab-page-move-option flex items-center gap-1.5 rounded px-2 py-1.5 text-[13px] cursor-pointer select-none text-[var(--nim-text)] ${
                  isSelected ? 'bg-[var(--nim-primary)]/20' : 'hover:bg-[var(--nim-bg-tertiary)]'
                }`}
                style={{ paddingLeft: 8 + option.depth * 18 }}
                data-page-option={rowId}
                onClick={() => setSelected(option.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    setSelected(option.id);
                  }
                }}
              >
                <MaterialSymbol icon={option.icon} size={18} className={isSelected ? 'text-[var(--nim-primary)]' : 'text-[var(--nim-text-muted)]'} />
                <span className="flex-1 truncate">{option.name}</span>
                {option.hint ? <span className="shrink-0 text-[11px] text-[var(--nim-text-faint)]">{option.hint}</span> : null}
              </div>
            );
          })}
        </div>
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-[var(--nim-border)]">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 bg-transparent rounded-md text-[var(--nim-text-muted)] text-[13px] hover:bg-[var(--nim-bg-tertiary)] hover:text-[var(--nim-text)]"
          >
            Cancel
          </button>
          <button
            type="button"
            className="collab-page-move-confirm px-3.5 py-1.5 rounded-md text-[13px] font-medium bg-[var(--nim-primary)] text-[#0f1115] disabled:opacity-50 disabled:cursor-not-allowed"
            disabled={selected === current}
            onClick={() => onConfirm(selected === UNDER_TYPE
              ? { underType: true }
              : {
                parentId: selected === null ? null : selected.slice(selected.indexOf(':') + 1),
                parentKind: selected?.startsWith('item:') ? 'item' : 'page',
              })}
          >
            Move
          </button>
        </div>
      </div>
    </div>
  );
}
