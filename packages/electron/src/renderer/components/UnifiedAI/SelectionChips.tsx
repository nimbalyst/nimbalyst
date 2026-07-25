import React, { useState, useSyncExternalStore } from 'react';
import {
  getEditorContextEntry,
  dismissEditorContextItem,
  restoreEditorContextItem,
  subscribeEditorContext,
  getEditorContextSnapshot,
} from '../../stores/editorContextStore';
import { getTextSelection, clearTextSelection } from './TextSelectionIndicator';
import { clearMockupAnnotationsForFile } from './MockupAnnotationIndicator';

interface SelectionChipsProps {
  /** Current document file path */
  currentFilePath?: string;
}

/** A single removable chip descriptor. */
interface Chip {
  key: string;
  icon?: string;
  label: string;
  tooltip?: string;
  groupLabel?: string;
  onRemove: () => void;
}

const MAX_COLLAPSED_GROUP_ITEMS = 5;

/**
 * Subscribe to all three selection sources (extension items, text selection,
 * mockup annotations) so the row re-renders when any of them changes.
 */
function subscribeAll(callback: () => void): () => void {
  const unsubStore = subscribeEditorContext(callback);
  const handleWindowEvent = () => {
    windowEventVersion++;
    callback();
  };
  window.addEventListener('text-selection-changed', handleWindowEvent);
  window.addEventListener('mockup-annotation-changed', handleWindowEvent);
  return () => {
    unsubStore();
    window.removeEventListener('text-selection-changed', handleWindowEvent);
    window.removeEventListener('mockup-annotation-changed', handleWindowEvent);
  };
}

// Combined snapshot: bump on any source change. The editor-context store's
// snapshot already increments on its own changes; window-event sources bump a
// local counter so React sees a new value.
let windowEventVersion = 0;
function getCombinedSnapshot(): number {
  return getEditorContextSnapshot() + windowEventVersion;
}

/**
 * Unified row of removable "what's selected" chips shown above the AI input.
 *
 * Replaces the separate TextSelection / MockupAnnotation / EditorContext
 * indicators. Every chip has an × so the user can drop a selection so it is
 * not sent to the model. Extension items support multiple selections and a
 * reversible "N hidden — restore" affordance; dropping resets when the editor
 * pushes a new selection.
 */
export const SelectionChips: React.FC<SelectionChipsProps> = ({ currentFilePath }) => {
  useSyncExternalStore(subscribeAll, getCombinedSnapshot);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());

  const extensionChips: Chip[] = [];
  const otherChips: Chip[] = [];

  // --- Extension-provided items (node-like editors, multi-selection) ---
  // Strictly scope to the panel's active document. Every mode that can hold a
  // selection passes its active doc path (Files: active tab; Collab: active
  // collab tab). Without an explicit, matching path we show nothing rather than
  // falling back to the most-recent entry — that fallback leaked a previous
  // mode's selection (e.g. a collab spreadsheet's cells) into an unrelated
  // panel after a mode switch.
  const entry = currentFilePath ? getEditorContextEntry(currentFilePath) : null;
  let dismissedCount = 0;
  if (entry) {
    for (const item of entry.items) {
      if (entry.dismissedIds.has(item.id)) {
        dismissedCount++;
        continue;
      }
      extensionChips.push({
        key: `item:${item.id}`,
        icon: item.icon,
        label: item.label,
        tooltip: item.description,
        groupLabel: item.groupLabel,
        onRemove: () => dismissEditorContextItem(item.id, entry.filePath),
      });
    }
  }

  // --- Text selection (single) ---
  // Scope strictly to the panel's active document (same reasoning as the
  // extension items above): show the selection only when it belongs to the doc
  // this panel is focused on, so a selection made in another mode does not leak
  // into an unrelated chat panel after a mode switch.
  const textSelection = getTextSelection();
  const textMatchesFile =
    !!textSelection &&
    textSelection.text.trim().length > 0 &&
    !!currentFilePath &&
    textSelection.filePath === currentFilePath;
  if (textMatchesFile && textSelection) {
    const preview =
      textSelection.text.length > 60 ? textSelection.text.slice(0, 60) + '…' : textSelection.text;
    otherChips.push({
      key: 'text-selection',
      icon: 'text_select_start',
      label: 'Selection',
      tooltip: `Selected text will be included: "${preview}"`,
      onRemove: () => clearTextSelection(),
    });
  }

  // --- Mockup annotations (single) ---
  const mockupFilePath = (window as any).__mockupFilePath as string | undefined;
  const hasMockupAnnotations =
    !!(window as any).__mockupDrawing || !!(window as any).__mockupSelectedElement;
  const mockupMatchesFile =
    !!mockupFilePath &&
    hasMockupAnnotations &&
    !!currentFilePath &&
    mockupFilePath === currentFilePath;
  if (mockupMatchesFile && mockupFilePath) {
    otherChips.push({
      key: 'mockup-annotations',
      icon: 'draw',
      label: 'Mockup annotations',
      tooltip: 'Annotations drawn on your mockup will be included with your prompt',
      onRemove: () => clearMockupAnnotationsForFile(mockupFilePath),
    });
  }

  const grouped = new Map<string, Chip[]>();
  const visibleExtensionChips: Chip[] = [];
  for (const chip of extensionChips) {
    if (!chip.groupLabel) {
      visibleExtensionChips.push(chip);
      continue;
    }
    const group = grouped.get(chip.groupLabel) ?? [];
    group.push(chip);
    grouped.set(chip.groupLabel, group);
  }

  const collapsedGroups: Array<{ label: string; hiddenCount: number; expanded: boolean }> = [];
  for (const [label, group] of grouped) {
    const expanded = expandedGroups.has(label);
    visibleExtensionChips.push(...(expanded ? group : group.slice(0, MAX_COLLAPSED_GROUP_ITEMS)));
    if (group.length > MAX_COLLAPSED_GROUP_ITEMS) {
      collapsedGroups.push({
        label,
        hiddenCount: group.length - MAX_COLLAPSED_GROUP_ITEMS,
        expanded,
      });
    }
  }

  const chips = [...visibleExtensionChips, ...otherChips];

  if (chips.length === 0 && dismissedCount === 0) {
    return null;
  }

  return (
    <div
      className="selection-chips"
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: '4px',
        marginBottom: '4px',
      }}
    >
      {chips.map((chip) => (
        <div
          key={chip.key}
          className="selection-chip"
          title={chip.tooltip}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
            maxWidth: '220px',
            padding: '2px 4px 2px 8px',
            fontSize: '12px',
            color: 'var(--nim-text-muted)',
            background: 'var(--nim-bg-tertiary)',
            border: '1px solid var(--nim-border)',
            borderRadius: '12px',
          }}
        >
          {chip.icon && (
            <span className="material-symbols-outlined" style={{ fontSize: '14px', lineHeight: 1 }}>
              {chip.icon}
            </span>
          )}
          <span
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {chip.label}
          </span>
          <button
            type="button"
            className="selection-chip-remove"
            aria-label={`Remove ${chip.label} from context`}
            onClick={chip.onRemove}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '16px',
              height: '16px',
              padding: 0,
              border: 'none',
              background: 'transparent',
              color: 'var(--nim-text-muted)',
              cursor: 'pointer',
              borderRadius: '50%',
            }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: '14px', lineHeight: 1 }}>
              close
            </span>
          </button>
        </div>
      ))}

      {collapsedGroups.map(({ label, hiddenCount, expanded }) => (
        <button
          key={`group:${label}`}
          type="button"
          className="selection-chips-group-toggle"
          aria-label={expanded ? `Show fewer ${label}` : `Show ${hiddenCount} more ${label}`}
          onClick={() => {
            setExpandedGroups((previous) => {
              const next = new Set(previous);
              if (expanded) next.delete(label);
              else next.add(label);
              return next;
            });
          }}
          style={{
            fontSize: '11px',
            color: 'var(--nim-text-muted)',
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            textDecoration: 'underline',
          }}
        >
          {expanded ? `Show fewer ${label}` : `+${hiddenCount} more ${label}`}
        </button>
      ))}

      {dismissedCount > 0 && (
        <button
          type="button"
          className="selection-chips-restore"
          onClick={() => {
            const current = currentFilePath ? getEditorContextEntry(currentFilePath) : null;
            if (current) {
              for (const id of Array.from(current.dismissedIds)) {
                restoreEditorContextItem(id, current.filePath);
              }
            }
          }}
          style={{
            fontSize: '11px',
            color: 'var(--nim-text-muted)',
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            textDecoration: 'underline',
          }}
        >
          {dismissedCount} hidden — restore
        </button>
      )}
    </div>
  );
};
