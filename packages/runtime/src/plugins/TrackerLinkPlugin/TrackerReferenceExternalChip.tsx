/**
 * A reference to another team project's item: its key and a link to its own
 * console page, never this project's item with the same key. On desktop the
 * console link router opens it in-app when this window holds that project and
 * in the browser otherwise; in the browser it is an ordinary link.
 */

import type { JSX } from 'react';
import * as React from 'react';
import { useSyncExternalStore } from 'react';

import {
  getTrackerReferenceHomeScope,
  subscribeTrackerReferenceHomeScope,
  trackerReferenceForeignScope,
} from './trackerReferenceHref';

/** Whether `href` names a team project other than the host's; follows the host's scope as it loads. */
export function useTrackerReferenceIsForeign(href: string | null): boolean {
  const home = useSyncExternalStore(subscribeTrackerReferenceHomeScope, getTrackerReferenceHomeScope, getTrackerReferenceHomeScope);
  return trackerReferenceForeignScope(href, home) !== null;
}

export function TrackerReferenceExternalChip({ referenceKey, href }: { referenceKey: string; href: string }): JSX.Element {
  return (
    <a
      className="tracker-reference-chip tracker-reference-chip--external"
      data-testid="tracker-reference-external"
      data-issue-key={referenceKey}
      data-resolved="false"
      href={href}
      title={`${referenceKey} in another project`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '3px',
        maxWidth: '100%',
        boxSizing: 'border-box',
        padding: '1px 6px',
        borderRadius: '10px',
        fontSize: '0.85em',
        fontWeight: 700,
        lineHeight: '1.5',
        verticalAlign: 'baseline',
        background: 'var(--nim-bg-secondary)',
        border: '1px dashed var(--nim-border)',
        color: 'var(--nim-text-muted)',
        textDecoration: 'none',
        whiteSpace: 'nowrap',
        userSelect: 'none',
      }}
    >
      {referenceKey}
      <span style={{ fontWeight: 400, fontSize: '0.9em' }}>another project</span>
    </a>
  );
}
