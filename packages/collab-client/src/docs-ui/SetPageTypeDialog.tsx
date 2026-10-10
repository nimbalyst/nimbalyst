/**
 * The type picker for "Set type" on a page: the section's own creatable types,
 * singular names, one click to convert. The resolver says which types take
 * new pages, so this bundle never reads the tracker registry.
 */

import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { CollabTypeTreeResolver } from '../docs/collabTree';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';

export interface SetPageTypeDialogProps {
  pageTitle: string;
  resolver: CollabTypeTreeResolver;
  running: boolean;
  onPick: (typeId: string) => void;
  onClose: () => void;
  /** Open "New type..." in this section; absent where the host cannot write a type. */
  onNewType?: () => void;
}

export function SetPageTypeDialog({ pageTitle, resolver, running, onPick, onClose, onNewType }: SetPageTypeDialogProps) {
  const types = (resolver.listedTypes?.() ?? [])
    .filter((type) => type.creatable !== false)
    .map((type) => ({ ...type, label: resolver.typeLabel?.(type.typeId) ?? type.name }));

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !running) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, running]);

  return createPortal(
    <div
      className="set-page-type-dialog fixed inset-0 z-[100] flex items-center justify-center bg-black/40"
      onClick={() => { if (!running) onClose(); }}
      data-testid="set-page-type-dialog"
    >
      <div
        className="w-[360px] max-w-[92vw] max-h-[70vh] flex flex-col bg-nim border border-nim rounded-lg shadow-xl overflow-hidden"
        role="dialog"
        aria-label="Set type"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="px-4 pt-3 pb-2 border-b border-nim">
          <div className="text-sm font-medium text-nim truncate">Set type: {pageTitle || 'Untitled'}</div>
          <div className="text-xs text-nim-faint mt-0.5">Give this page a type. It keeps its place and its text.</div>
        </div>
        <div className="flex-1 overflow-y-auto py-1">
          {types.length === 0 ? (
            <div className="px-4 py-3 text-xs text-nim-faint">
              {onNewType ? 'This section has no types yet. Create one to give this page a type.' : 'No types are available in this section.'}
            </div>
          ) : null}
          {types.map((type) => (
            <button
              key={type.typeId}
              type="button"
              disabled={running}
              className="set-page-type-option w-full flex items-center gap-2 px-4 py-1.5 text-left text-sm text-nim hover:bg-nim-hover disabled:opacity-50"
              onClick={() => onPick(type.typeId)}
              data-testid={`set-page-type-option-${type.typeId}`}
            >
              <MaterialSymbol icon={type.icon || 'label'} size={16} />
              <span className="truncate">{type.label}</span>
            </button>
          ))}
          {onNewType ? (
            <button
              type="button"
              disabled={running}
              className="set-page-type-new w-full flex items-center gap-2 px-4 py-1.5 text-left text-sm text-nim-muted hover:text-nim hover:bg-nim-hover disabled:opacity-50"
              onClick={onNewType}
              data-testid="set-page-type-new-type"
            >
              <MaterialSymbol icon="add" size={16} />
              <span className="truncate">New type...</span>
            </button>
          ) : null}
        </div>
        <div className="px-4 py-2 border-t border-nim flex items-center justify-between">
          <span className="text-xs text-nim-faint">{running ? 'Setting type...' : ''}</span>
          <button
            type="button"
            disabled={running}
            className="text-xs text-nim-muted hover:text-nim disabled:opacity-50"
            onClick={onClose}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
