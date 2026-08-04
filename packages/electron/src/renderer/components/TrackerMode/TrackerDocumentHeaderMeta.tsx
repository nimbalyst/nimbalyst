/**
 * TrackerDocumentHeaderMeta - the breadcrumb + connection state + presence
 * cluster shown on the left of the tracker document view's header bar.
 *
 * Deliberately a mirror of `CollabDocumentHeaderMeta` (the collaborative
 * document tab's equivalent): same segment markup, same icons, same sync dot,
 * same avatar stack. A tracker body in document view IS a collaborative
 * document, so it should read as one -- the only difference is where the
 * segments come from. File-backed items show their backing path; DB-only items
 * fall back to the collection and type they live under, because there is no
 * file to name.
 */

import React from 'react';
import { TrackerCollabAvatars, TrackerCollabSyncDot } from './trackerCollabChrome';
import type { TrackerDocumentBreadcrumb } from './TrackerDocumentViewHeader';

/** Segment list plus a tooltip, derived from either breadcrumb shape. */
export function trackerBreadcrumbSegments(
  breadcrumb: TrackerDocumentBreadcrumb,
  title: string,
): { segments: string[]; tooltip: string } {
  if (breadcrumb.kind === 'file') {
    return {
      segments: breadcrumb.segments,
      tooltip: breadcrumb.fullPath,
    };
  }
  // No backing file: name where the item lives instead of inventing a path.
  const segments = [breadcrumb.collection, breadcrumb.typeLabel, title].filter(Boolean);
  return { segments, tooltip: segments.join(' / ') };
}

interface TrackerDocumentHeaderMetaProps {
  /** Item whose body doc supplies the connection state and presence. */
  itemId: string;
  breadcrumb: TrackerDocumentBreadcrumb;
  /** Item title, used as the last segment when there is no backing file. */
  title: string;
  /** Only a collaborative body has a sync dot and presence to show. */
  showCollabChrome: boolean;
}

export const TrackerDocumentHeaderMeta: React.FC<TrackerDocumentHeaderMetaProps> = ({
  itemId,
  breadcrumb,
  title,
  showCollabChrome,
}) => {
  const { segments, tooltip } = trackerBreadcrumbSegments(breadcrumb, title);

  return (
    <div className="tracker-document-header-meta flex min-w-0 items-center gap-2">
      <div
        className="tracker-document-breadcrumb flex min-w-0 items-center gap-1.5 overflow-hidden text-[13px]"
        data-testid="tracker-document-breadcrumb"
        title={tooltip}
      >
        {segments.map((segment, index) => {
          const isLast = index === segments.length - 1;
          return (
            <React.Fragment key={`${segment}-${index}`}>
              <span className={`breadcrumb-segment flex items-center gap-1 whitespace-nowrap ${
                isLast
                  ? 'breadcrumb-filename text-[var(--nim-text)] font-medium'
                  : 'text-[var(--nim-text-muted)]'
              }`}>
                <span
                  className="material-symbols-outlined breadcrumb-icon shrink-0 opacity-75"
                  style={{ fontSize: '14px' }}
                  aria-hidden="true"
                >
                  {isLast ? 'description' : 'folder'}
                </span>
                {segment}
              </span>
              {!isLast && (
                <span className="breadcrumb-separator text-[var(--nim-text-faint)] text-[11px]">/</span>
              )}
            </React.Fragment>
          );
        })}
        {breadcrumb.kind === 'file' && breadcrumb.dirty && (
          <span
            className="ml-0.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--nim-warning)]"
            title="Unsaved changes"
            data-testid="tracker-document-breadcrumb-dirty"
          />
        )}
      </div>
      {showCollabChrome && (
        <>
          <TrackerCollabSyncDot itemId={itemId} />
          <TrackerCollabAvatars itemId={itemId} />
        </>
      )}
    </div>
  );
};
