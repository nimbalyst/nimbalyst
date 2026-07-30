/**
 * TrackerDocumentViewHeader - the focused-view header for Tracker Mode's
 * document layout.
 *
 * The list pane owns collection/type navigation, and the document header bar
 * below owns everything the collaborative document tab already owns -- the
 * breadcrumb, connection state, presence, table of contents, and the document
 * menu. This header is therefore only the tracker's identity row: issue key,
 * title, editable field pills, and the way back out.
 *
 * Purely presentational so it can be tested without the tracker store: the
 * container resolves the record, status option, and dirty state.
 */

import React from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';
import './TrackerDocumentView.css';

/** Where the document's content is stored, as shown in the breadcrumb line. */
export type TrackerDocumentBreadcrumb =
  | {
      kind: 'file';
      /** Path segments of the backing file, project-relative when possible. */
      segments: string[];
      /** Unsaved edits pending on the backing file. */
      dirty: boolean;
      /** Full path, shown on hover. */
      fullPath: string;
    }
  | {
      kind: 'degraded';
      /** Collection the item belongs to (e.g. "Trackers"). */
      collection: string;
      /** Human type name (e.g. "Plans"). */
      typeLabel: string;
    };

interface TrackerDocumentViewHeaderProps {
  /** Issue key chip content (falls back to the raw id upstream). */
  issueKey: string | null;
  title: string;
  /** Compact schema-driven field editors (status included). */
  fieldPills?: React.ReactNode;
  /** Return to the ordinary tracker list + detail-panel presentation. */
  onCollapseToTracker: () => void;
}

export const TrackerDocumentViewHeader: React.FC<TrackerDocumentViewHeaderProps> = ({
  issueKey,
  title,
  fieldPills,
  onCollapseToTracker,
}) => {
  return (
    <header
      className="tracker-document-view-header shrink-0 border-b border-nim bg-nim px-3 pt-2 pb-1.5"
      data-testid="tracker-document-view-header"
    >
      <div className="text-[9px] font-semibold uppercase tracking-[0.12em] text-nim-faint">
        Expanded tracker content
      </div>

      <div className="flex items-center gap-2 mt-0.5">
        {issueKey && (
          <span
            className="shrink-0 rounded bg-nim-tertiary px-1.5 py-0.5 font-mono text-[10px] font-medium text-nim-muted select-text"
            data-testid="tracker-document-issue-key"
          >
            {issueKey}
          </span>
        )}

        <h2
          className="min-w-0 flex-1 truncate text-[13px] font-semibold text-nim m-0 select-text"
          title={title}
          data-testid="tracker-document-title"
        >
          {title}
        </h2>

        <button
          type="button"
          className="shrink-0 inline-flex items-center gap-1 rounded border border-nim px-2 py-1 text-[11px] font-medium text-nim-muted transition-colors hover:bg-nim-tertiary hover:text-nim"
          onClick={onCollapseToTracker}
          title="Collapse to tracker (Esc)"
          data-testid="tracker-document-collapse"
        >
          <MaterialSymbol icon="close_fullscreen" size={14} />
          Collapse to tracker
          <kbd className="ml-0.5 rounded border border-nim px-1 font-sans text-[9px] leading-[14px] text-nim-faint">
            Esc
          </kbd>
        </button>
      </div>

      {fieldPills && (
        <div className="mt-1" data-testid="tracker-document-header-field-pills">
          {fieldPills}
        </div>
      )}
    </header>
  );
};

interface TrackerDocumentListPaneHeaderProps {
  collectionLabel: string;
  typeLabel: string;
  onNavigateToTypeList: () => void;
}

/**
 * Collection navigation belongs to the list it scopes, not to the selected
 * document. Both breadcrumb segments return to the type's ordinary list.
 */
export const TrackerDocumentListPaneHeader: React.FC<TrackerDocumentListPaneHeaderProps> = ({
  collectionLabel,
  typeLabel,
  onNavigateToTypeList,
}) => (
  <header
    className="tracker-document-list-pane-header flex h-[42px] shrink-0 items-center border-b border-nim px-3"
    data-testid="tracker-document-list-pane-header"
  >
    <nav
      className="flex min-w-0 items-center gap-1 text-[11px] font-medium text-nim-faint"
      aria-label="Tracker collection"
      data-testid="tracker-document-list-breadcrumb"
    >
      <button
        type="button"
        className="tracker-document-collection-navigation truncate rounded-sm border-0 bg-transparent p-0 font-[inherit] text-nim-faint cursor-pointer hover:text-nim hover:underline"
        onClick={onNavigateToTypeList}
        data-testid="tracker-document-collection-navigation"
      >
        {collectionLabel}
      </button>
      <span aria-hidden="true">/</span>
      <button
        type="button"
        className="tracker-document-type-navigation truncate rounded-sm border-0 bg-transparent p-0 font-[inherit] text-nim-muted cursor-pointer hover:text-nim hover:underline"
        onClick={onNavigateToTypeList}
        title={`Back to ${typeLabel}`}
        data-testid="tracker-document-type-navigation"
      >
        {typeLabel}
      </button>
    </nav>
  </header>
);
