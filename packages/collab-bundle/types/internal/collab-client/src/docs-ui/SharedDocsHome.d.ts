/**
 * SharedDocsHome — the Shared Documents discovery hub rendered in CollabMode's
 * center pane (empty state, and reachable via the Home affordance while docs
 * are open). Search + Favorites + New & Changed + Recently opened + All.
 *
 * Purely presentational over the discovery atoms; opening a doc delegates to
 * the same `onDocumentSelect` path the sidebar uses.
 */
import React from 'react';
import { type SharedDocument } from '../docs/index';
import { resolveSharedDocumentTypePresentation } from './documentPresentation';
export interface SharedDocsHomeProps {
}
/** Resolve through the live catalog so unloaded extensions never borrow another editor's icon. */
export declare function iconForSharedDocument(doc: SharedDocument, descriptors?: Parameters<typeof resolveSharedDocumentTypePresentation>[1]): string;
export declare const SharedDocsHome: React.FC<SharedDocsHomeProps>;
