/**
 * Citation inspector (knowledge-scopes contract 4.4, N7).
 *
 * Answers four questions about one citation, in this order, because that is the
 * order in which a reader stops trusting it:
 *
 * 1. **What does it assert?** The relation (supports / challenges / context),
 *    the explanation, and the excerpt.
 * 2. **Where exactly?** The locator, rendered property by property rather than
 *    as a summary string. A locator a reader cannot see is a locator nobody
 *    checks.
 * 3. **From which retrieval?** The capture: when, what answered, what outcome,
 *    what digest. A citation with no capture is an assertion about a document
 *    nobody recorded reading.
 * 4. **Against which revision?** The pinned revision of the cited item, read
 *    through the host's exact-revision read.
 *
 * The load-bearing behavior is in (2) and (4). A locator that fails validation
 * is shown AS invalid with its error codes, never silently omitted, because a
 * citation whose address is malformed looks exactly like one with no address.
 * And a pinned revision that cannot be read renders as an explicit failure
 * rather than falling back to the item as it is today: showing newer evidence
 * under a pin is the one outcome contract 4.2 exists to prevent, and nothing in
 * a silently-substituted render would say the evidence moved.
 */
import React from 'react';
import { type CitationFieldValue } from '../../../../../tracker-schema/src/browser';
/** A tracker item as the inspector needs it, with no dependency on the host's item type. */
export interface CitationInspectorItem {
    itemId: string;
    type?: string;
    issueKey?: string;
    title?: string;
    /** Flattened field bag: schema fields and custom fields together. */
    fields: Record<string, unknown>;
}
/** How a caller names the revision it wants. Mirrors `TrackerRevisionRef`. */
export interface CitationRevisionRef {
    revisionId?: string;
    serverRevision?: number;
}
export interface CitationPinnedRevision {
    revisionId: string;
    serverRevision: number | null;
    deletedAt: number | null;
    recordedAt: number;
    data: Record<string, unknown>;
}
/**
 * Everything the inspector needs from its host, injected rather than imported:
 * this component lives in `runtime`, and the data source that backs it lives in
 * `collab-client`, which depends on `runtime` and not the other way round.
 */
export interface CitationInspectorHost {
    /** Resolve an already-loaded item (the citation, its capture, its source). */
    lookupItem(itemId: string): CitationInspectorItem | null;
    /**
     * Read one exact revision. MUST reject when the revision is missing or the
     * host keeps no revision log; it must never answer with the live item.
     * Absent when the host has no revision read at all.
     */
    readRevision?(itemId: string, ref: CitationRevisionRef): Promise<CitationPinnedRevision>;
}
export interface CitationInspectorProps {
    entry: CitationFieldValue;
    host: CitationInspectorHost;
    /** Open the citation item itself, for editing. */
    onOpenItem?: (itemId: string) => void;
}
export declare const CitationInspector: React.FC<CitationInspectorProps>;
