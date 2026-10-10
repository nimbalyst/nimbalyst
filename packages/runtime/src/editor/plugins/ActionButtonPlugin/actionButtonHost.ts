/**
 * The host's half of the action buttons. The runtime block parses the fence,
 * shows what a click will do and asks for confirmation; only the host knows
 * how to start a session or create a typed page. A host that cannot do one
 * (the web console, headless, mobile) leaves that method out, and the button
 * renders disabled with `unavailableReason`.
 *
 * One slot per process, set at startup like `setTransclusionHost`.
 */

import type { EffortLevel } from '../../../ai/server/effortLevels';

export type ActionButtonResult = { ok: true } | { ok: false; error: string };

export interface StartSessionRequest {
  label: string;
  prompt: string;
  model?: string;
  effort?: EffortLevel;
  /**
   * The page the button sits on, as the host's tabs name it (`collab://...`,
   * `personal://...`, `tracker://<id>`, or a file path); null when unknown.
   */
  pagePath: string | null;
}

export interface NewItemRequest {
  type: string;
  title: string;
  /** Body markdown for the new page; '' for an empty page. */
  body: string;
  /** The page to place the new item under; see `StartSessionRequest.pagePath`. */
  pagePath: string | null;
  /** Cmd/Ctrl-click: open the new page in a new tab instead of this one. */
  newTab: boolean;
}

/**
 * A session launch with every setting resolved: the model that will actually
 * run (the user's default when the fence names none), and the effort after
 * clamping to that model. The review shows this object and `startSession`
 * receives the same one, so what the user approved is what runs.
 */
export interface SessionLaunch {
  label: string;
  prompt: string;
  model: string;
  /** The model's display name. */
  modelName: string;
  /** True when the fence named no model and the user's default was used. */
  usesDefaultModel: boolean;
  effort: EffortLevel;
  /** What the fence asked for, when it named an effort. */
  requestedEffort?: EffortLevel;
  /** True when the requested effort is above what the model supports. */
  effortClamped: boolean;
  pagePath: string | null;
}

export type ResolveSessionResult = { ok: true; launch: SessionLaunch } | { ok: false; error: string };

export interface ActionButtonHost {
  /** Resolves and validates a launch before the review shows it. Never starts anything. */
  resolveSession?(request: StartSessionRequest): Promise<ResolveSessionResult>;
  /** Starts the reviewed launch, with the page as context. Only ever called after the user confirmed. */
  startSession?(launch: Readonly<SessionLaunch>): Promise<ActionButtonResult>;
  /** Creates a typed page, places it under `pagePath`, and opens it. */
  createItem?(request: NewItemRequest): Promise<ActionButtonResult>;
}

let host: ActionButtonHost | null = null;

export function setActionButtonHost(next: ActionButtonHost | null): void {
  host = next;
}

export function getActionButtonHost(): ActionButtonHost | null {
  return host;
}

export const SESSION_UNAVAILABLE_REASON = 'Starting a session needs the Nimbalyst desktop app.';
export const NEW_ITEM_UNAVAILABLE_REASON = 'Creating pages from a button needs the Nimbalyst desktop app.';

/**
 * The page an element sits on, read from the host's DOM: the editor tab's
 * `data-file-path`, or a typed page view's item id.
 */
export function pagePathOf(element: Element | null): string | null {
  const page = element?.closest('[data-file-path], .tracker-page-view[data-item-id]');
  if (!page) return null;
  const filePath = page.getAttribute('data-file-path');
  if (filePath) return filePath;
  const itemId = page.getAttribute('data-item-id');
  return itemId ? `tracker://${itemId}` : null;
}
