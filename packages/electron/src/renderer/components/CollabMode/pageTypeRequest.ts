/**
 * Requests raised from a page's own header, which renders in a tab root with
 * no tabs context. Pages' sidebar owns the Set type dialog and the tab strip,
 * and answers them.
 */
import { atom } from 'jotai';
import type { SharedDocument } from '@nimbalyst/collab-client/docs';
import type { PageTypeLane } from '@nimbalyst/collab-client/docs/pageTypes';
import type { CollabPageActionRequest } from '@nimbalyst/collab-client/docs-ui';

export const pageTypeRequestAtom = atom<{ lane: PageTypeLane; page: SharedDocument } | null>(null);

/** Move a page (with its plain sub-pages) to the other Pages section. */
export const pageMoveRequestAtom = atom<{ from: PageTypeLane; pageId: string } | null>(null);

/** Rename, Move to..., New page inside or Move to Trash, run by that section's tree. */
export const pageActionRequestAtom = atom<({ lane: PageTypeLane } & CollabPageActionRequest) | null>(null);

/** Any request still waiting for the sidebar, which answers them only while it is shown. */
export const pageHeaderRequestPendingAtom = atom((get) => (
  get(pageTypeRequestAtom) !== null || get(pageMoveRequestAtom) !== null || get(pageActionRequestAtom) !== null
));
