/**
 * The one piece of a page's frontmatter shown above its text: its status when
 * it is not `current` (draft, superseded...), or that the frontmatter does
 * not parse. Clicking it opens Page info. Importing this module registers it
 * as a document header.
 */

import React, { useMemo } from 'react';
import {
  DocumentHeaderRegistry,
  type DocumentHeaderComponentProps,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/documentHeader/DocumentHeaderRegistry';
import { frontmatterStatusBadge } from '@nimbalyst/runtime/plugins/FrontmatterPlugin/frontmatterPresence';
import { setPageInfoPanelOpen } from './pageInfoPanelState';

export const PAGE_STATUS_CHIP_PROVIDER_ID = 'page-status-chip';

export function PageStatusChip({ filePath, getContent, contentVersion }: DocumentHeaderComponentProps) {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const badge = useMemo(() => frontmatterStatusBadge(getContent(), filePath), [getContent, contentVersion, filePath]);
  if (!badge) return null;
  const invalid = badge.kind === 'invalid';
  return (
    <div className="page-status-chip-row px-[46px] pt-3 max-[1025px]:px-2" contentEditable={false}>
      <button
        type="button"
        className={`page-status-chip cursor-pointer rounded-full border px-2.5 py-px text-[11px] ${invalid
          ? 'border-red-500/40 bg-red-500/10 text-red-500'
          : 'border-nim-warning bg-nim-warning-subtle text-nim-warning'}`}
        onClick={() => setPageInfoPanelOpen(true)}
        title="Open Page info"
        data-testid="page-status-chip"
      >
        {invalid ? 'Invalid frontmatter' : badge.status}
      </button>
    </div>
  );
}

DocumentHeaderRegistry.register({
  id: PAGE_STATUS_CHIP_PROVIDER_ID,
  priority: 50,
  shouldRender: (content, filePath) => frontmatterStatusBadge(content, filePath) !== null,
  component: PageStatusChip,
  // Part of the page, above its first line, not a header bar.
  inline: true,
});
