import type { JSX } from 'react';
import { useState } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';

interface TrackerViewTitleProps {
  fallbackTitle: string;
  activeSavedViewName?: string | null;
  savedViewDirty?: boolean;
  showSaveViewAction?: boolean;
  onSaveView: (name: string) => void;
  onRenameSavedView: (name: string) => void;
  onUpdateSavedView: () => void;
}

export function TrackerViewTitle({
  fallbackTitle,
  activeSavedViewName = null,
  savedViewDirty = false,
  showSaveViewAction = false,
  onSaveView,
  onRenameSavedView,
  onUpdateSavedView,
}: TrackerViewTitleProps): JSX.Element {
  const [editMode, setEditMode] = useState<'create' | 'rename' | null>(null);
  const [viewName, setViewName] = useState('');

  const cancelNaming = (): void => {
    setEditMode(null);
    setViewName('');
  };

  const commitViewName = (): void => {
    const name = viewName.trim();
    if (!name) return;
    if (editMode === 'rename') {
      onRenameSavedView(name);
    } else {
      onSaveView(name);
    }
    cancelNaming();
  };

  if (editMode) {
    return (
      <div
        className="flex h-7 shrink-0 items-center overflow-hidden rounded border border-nim-focus bg-nim-secondary"
        data-testid="tracker-view-title-editor"
      >
        <MaterialSymbol
          icon={editMode === 'rename' ? 'bookmark' : 'bookmark_add'}
          size={14}
          className="ml-2 text-[var(--nim-primary)]"
        />
        <input
          autoFocus
          value={viewName}
          onFocus={event => {
            if (editMode === 'rename') event.currentTarget.select();
          }}
          onChange={event => setViewName(event.target.value)}
          onKeyDown={event => {
            event.stopPropagation();
            if (event.key === 'Enter') commitViewName();
            if (event.key === 'Escape') cancelNaming();
          }}
          onBlur={() => {
            if (viewName.trim()) commitViewName();
            else cancelNaming();
          }}
          placeholder={editMode === 'rename' ? 'View name…' : 'Name this view…'}
          className="h-full w-44 bg-transparent px-2 text-sm font-semibold text-nim outline-none placeholder:font-normal placeholder:text-nim-faint"
          data-testid="tracker-saved-view-name-input"
        />
        <button
          type="button"
          className="inline-flex h-full w-7 items-center justify-center text-[var(--nim-primary)] hover:bg-nim-tertiary disabled:opacity-35"
          disabled={!viewName.trim()}
          onMouseDown={event => event.preventDefault()}
          onClick={commitViewName}
          aria-label={editMode === 'rename' ? 'Save view name' : 'Save named view'}
          data-testid="tracker-saved-view-save"
        >
          <MaterialSymbol icon="check" size={14} />
        </button>
        <button
          type="button"
          className="inline-flex h-full w-7 items-center justify-center text-nim-faint hover:bg-nim-tertiary hover:text-nim"
          onMouseDown={event => event.preventDefault()}
          onClick={cancelNaming}
          aria-label="Cancel saving view"
        >
          <MaterialSymbol icon="close" size={13} />
        </button>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 shrink-0 items-center gap-2">
      {activeSavedViewName ? (
        <button
          type="button"
          className="group inline-flex min-w-0 max-w-56 items-center gap-1 truncate rounded px-0.5 text-sm font-semibold text-nim hover:bg-nim-tertiary"
          onClick={() => {
            setViewName(activeSavedViewName);
            setEditMode('rename');
          }}
          data-testid="tracker-view-title"
          title="Rename saved view"
        >
          <span className="truncate">{activeSavedViewName}</span>
          <MaterialSymbol
            icon="edit"
            size={12}
            className="shrink-0 text-nim-faint opacity-0 transition-opacity group-hover:opacity-100"
          />
        </button>
      ) : (
        <span
          className="max-w-56 truncate text-sm font-semibold text-nim"
          data-testid="tracker-view-title"
          title={fallbackTitle}
        >
          {fallbackTitle}
        </span>
      )}
      {activeSavedViewName && savedViewDirty ? (
        <button
          type="button"
          className="inline-flex h-7 items-center gap-1 rounded border border-nim px-2 text-[11px] font-medium text-nim-muted hover:bg-nim-tertiary hover:text-nim"
          onClick={onUpdateSavedView}
          data-testid="tracker-saved-view-update"
        >
          <MaterialSymbol icon="save" size={13} />
          Save changes
        </button>
      ) : !activeSavedViewName && showSaveViewAction ? (
        <button
          type="button"
          className="inline-flex h-7 items-center gap-1 rounded border border-nim px-2 text-[11px] font-medium text-nim-muted hover:bg-nim-tertiary hover:text-nim"
          onClick={() => setEditMode('create')}
          data-testid="tracker-saved-view-add"
        >
          <MaterialSymbol icon="bookmark_add" size={13} />
          Save view
        </button>
      ) : null}
    </div>
  );
}
