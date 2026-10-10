/**
 * The team's marks index: decision and open-question marks
 * (`[sentence]{decided by=... email=... on=... over=...}`) found in team page
 * bodies. The server extracts them when a body changes and keeps them in the
 * TeamRoom, so a client can list marks from pages it has never opened.
 *
 * New servers also cover typed pages with live TrackerRoom membership checks.
 * A member is answered only with marks from documents they can read; trashed
 * documents are never included.
 */

export type PageMarkEntryKind = 'decided' | 'open';

/** One mark in a team page body. */
export interface PageMarkEntry {
  /** The page's document id in the doc index. */
  documentId: string;
  /** Project of the page; null for a page outside any project. */
  projectId: string | null;
  /** Page title from the doc index; null when it cannot be read. */
  title: string | null;
  /** Present only after live typed-item membership and archive checks. */
  typedPage?: { itemId: string; typeId: string | null; issueKey: string | null };
  kind: PageMarkEntryKind;
  /** The marked sentence as inline markdown. */
  text: string;
  /** The sentence reduced to plain text. */
  plainText: string;
  by: string | null;
  /** The person's email, the stable identity marks are searched by. */
  email: string | null;
  /** `YYYY-MM-DD` as written. */
  on: string | null;
  /** What was not chosen (decided marks). */
  over: string | null;
  /** 1-based line of the mark in the body's markdown. */
  line: number;
  /** Offset of the mark in the body's markdown; with `documentId`, the mark's id. */
  offset: number;
}

/** Client -> TeamRoom: list marks. Every filter is optional. */
export interface TeamPageMarksQueryMessage {
  type: 'pageMarksQuery';
  /** Echoed on the response so a client can run several queries at once. */
  requestId: string;
  projectId?: string;
  kind?: PageMarkEntryKind;
  /** Only marks by this person (case-insensitive). */
  email?: string;
  /** Only marks in these documents. */
  documentIds?: string[];
}

/** TeamRoom -> the asking connection only. */
export interface TeamPageMarksResponseMessage {
  type: 'pageMarksResponse';
  requestId: string;
  marks: PageMarkEntry[];
  /** `partial` until the server has indexed every page once. */
  status: 'ready' | 'partial';
  /** Absent on older servers that exclude typed-page bodies. */
  coverage?: 'all-page-kinds';
}

/**
 * TeamRoom -> every synced connection: some page's marks changed, so an open
 * marks list asks again. Carries nothing, so it says nothing about pages a
 * member cannot read.
 */
export interface TeamPageMarksChangedMessage {
  type: 'pageMarksChanged';
}
