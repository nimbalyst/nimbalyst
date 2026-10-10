/**
 * The browser's tracker reference renderer. A reference whose link names the
 * author's own items (`https://console.nimbalyst.com/app/item/<KEY>`, a typed
 * page in their Personal pages) is kept on the author's device: its key means
 * nothing in this team project, so it is never resolved here. It shows as an
 * "on the author's device" chip that opens the console's open-in-app page.
 * Every other reference renders live.
 */

import React from 'react';
import { parseConsoleLink } from '@nimbalyst/collab-protocol';
import type { TrackerReferenceNodeRendererProps } from '@nimbalyst/runtime/plugins/TrackerLinkPlugin/TrackerReferenceNodeRenderer';
import { LiveTrackerReferenceRenderer } from '@nimbalyst/collab-client/trackers-ui/references';

import { openConsoleLink } from './consoleLinkOpener';

function isAuthorDeviceLink(href: string | null | undefined): href is string {
  const target = parseConsoleLink(href);
  return target?.kind === 'item' && target.scope === 'local';
}

export function AuthorDeviceReferenceChip({ referenceKey, href }: { referenceKey: string; href: string }): React.JSX.Element {
  return (
    <a
      className="tracker-reference-chip tracker-reference-chip--author-device"
      data-testid="tracker-reference-author-device"
      data-issue-key={referenceKey}
      data-resolved="false"
      href={href}
      title="A Personal page, kept on its author's device. Opens in Nimbalyst there."
      onClick={(event) => {
        if (openConsoleLink(href)) event.preventDefault();
      }}
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
      <span style={{ fontWeight: 400, fontSize: '0.9em' }}>on the author&apos;s device</span>
    </a>
  );
}

export function BrowserTrackerReferenceRenderer({ href, ...props }: TrackerReferenceNodeRendererProps): React.JSX.Element {
  if (isAuthorDeviceLink(href)) return <AuthorDeviceReferenceChip referenceKey={props.referenceKey} href={href} />;
  return <LiveTrackerReferenceRenderer {...props} />;
}
