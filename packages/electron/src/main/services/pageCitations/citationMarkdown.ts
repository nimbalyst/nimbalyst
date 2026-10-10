/**
 * The ready-to-paste markdown for a human citation (Decision 18), built with
 * the shared citation syntax so the page editor reads back exactly what this
 * tool hands the agent:
 *
 *   [GH](<human citation href> "by=... email=... at=... ctx=... quote=...")
 *
 * The page keeps the snapshot (who, when, the quote) so a teammate reads it
 * without the session; the link only resolves on the author's devices.
 */

import {
  createHumanCitation,
  formatCitationMarkdown,
  type CitationInputKind,
} from '@nimbalyst/runtime/core/citationSyntax';

export type CitableInputKind = CitationInputKind;

export interface CitationSnapshot {
  sessionId: string;
  kind: CitableInputKind;
  key: string;
  by: string;
  /** Stable identity of the person; citations are searched by it. */
  email?: string;
  /** ISO 8601. */
  at: string;
  context?: string;
  quote: string;
}

/** Never builds the URL itself: the scheme lives in `citationSyntax` only. */
export function citationMarkdown(snapshot: CitationSnapshot): string {
  return formatCitationMarkdown(createHumanCitation({
    sessionId: snapshot.sessionId,
    inputKind: snapshot.kind,
    key: snapshot.key,
    by: snapshot.by,
    ...(snapshot.email ? { email: snapshot.email } : {}),
    at: snapshot.at,
    ...(snapshot.context ? { context: snapshot.context } : {}),
    quote: snapshot.quote,
  }));
}
