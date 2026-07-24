/**
 * Tracker importer contract.
 *
 * An importer lets Nimbalyst pull items from an external system (GitHub Issues,
 * Linear, ...) into the native tracker as ordinary items that carry a back-link
 * to their upstream source (see the `origin` field on tracker items).
 *
 * This is a strict READ-side, one-shot subset of the broader `TrackerProvider`
 * design: `listBindings` + `list` + `fetch` are enough to power snapshot import.
 * Write/sync/comment methods can be added later as optional methods without
 * breaking importers written against this contract.
 *
 * ## Runtime model
 *
 * Importers do privileged work (network calls, spawning `gh`, reading tokens),
 * so the implementation runs inside the extension's **backend module**
 * (utility-process) — not the renderer. The methods below are the RPC surface
 * the backend module exports under the `importer.*` namespace; the host's
 * `TrackerImporterRegistry` invokes them and owns turning a {@link TrackerSnapshot}
 * into a real tracker item through the normal create path (so sync, body Y.Doc,
 * activity, and issue-key allocation all fire identically to a hand-created item).
 *
 * The contribution therefore points at a `backendModuleId` (declared in
 * `contributions.backendModules`) rather than a renderer component.
 */

/** Method names the importer backend module must export, namespaced `importer.*`. */
export const TRACKER_IMPORTER_RPC_METHODS = {
  isAuthenticated: 'importer.isAuthenticated',
  listBindings: 'importer.listBindings',
  list: 'importer.list',
  fetch: 'importer.fetch',
  openExternal: 'importer.openExternal',
} as const;

/**
 * Manifest declaration for an importer. Lives in
 * `contributions.trackerImporters[]`.
 */
export interface TrackerImporterContribution {
  /** Stable id, kebab-case. Used as the `providerId` on imported items' origin. */
  id: string;
  /** Human-readable name, e.g. 'GitHub Issues'. */
  displayName: string;
  /** Material icon name, e.g. 'bug_report'. */
  icon: string;
  /** URN scheme this importer owns, e.g. 'github' | 'linear'. Routes by URN. */
  urnScheme: string;
  /**
   * Id of the backend module (from `contributions.backendModules`) that
   * implements the `importer.*` RPC methods.
   */
  backendModuleId: string;
  /** Tracker types this importer may create. Empty/undefined = any creatable type. */
  importsAs?: string[];
  /** Settings panel id (from `contributions.settingsPanel`) handling auth + bindings. */
  settingsPanelId?: string;
}

/** A configured import target within a provider (a GitHub repo, a Linear team, ...). */
export interface ImporterBinding {
  /** Per-binding id, e.g. 'nimbalyst/nimbalyst' for a GitHub repo. */
  id: string;
  /** Human-readable label for the binding chooser. */
  label: string;
}

/** Advisory filters for {@link ImporterMethods.list}. The importer applies what it supports. */
export interface ImporterListFilter {
  search?: string;
  state?: 'open' | 'closed' | 'all';
  labels?: string[];
  cursor?: string;
  limit?: number;
}

/** Lightweight list entry; the full body is fetched lazily via {@link ImporterMethods.fetch}. */
export interface ImporterListEntry {
  externalId: string;
  urn: string;
  url: string;
  title: string;
  state: string;
  updatedAt: string;
}

export interface ImporterListPage {
  items: ImporterListEntry[];
  nextCursor?: string;
}

/** Identity of an upstream author, matching the host's tracker identity shape. */
export interface ImporterIdentity {
  email: string | null;
  displayName: string;
  gitName?: string | null;
  gitEmail?: string | null;
}

/**
 * Pointer to the upstream record, minus the host-stamped timestamps
 * (`importedAt` / `lastSyncedAt`), which the host fills in on import.
 */
export interface ImporterExternalRef {
  providerId: string;
  externalId: string;
  urn: string;
  url: string;
  titleSnapshot: string;
  stateSnapshot?: string;
}

/**
 * One-shot snapshot returned by {@link ImporterMethods.fetch}. The host converts
 * this into a tracker item (markdown body -> Lexical state, status mapped to a
 * workspace status, etc.).
 */
export interface TrackerSnapshot {
  external: ImporterExternalRef;
  /** Tracker type to create as; importer picks from its `importsAs`. */
  primaryType: string;
  title: string;
  /** Markdown body; host converts to Lexical content on insert. */
  body?: string;
  status?: string;
  priority?: string;
  labels?: string[];
  authorIdentity?: ImporterIdentity | null;
  upstreamCreatedAt?: string;
  upstreamUpdatedAt?: string;
}

/**
 * The RPC surface an importer backend module implements. Each method maps to a
 * `TRACKER_IMPORTER_RPC_METHODS` entry. All are async (they cross the
 * backend-module RPC boundary).
 */
export interface ImporterMethods {
  /** Has the user authenticated this importer? UI hides import flows otherwise. */
  isAuthenticated(): Promise<boolean>;
  /** Per-workspace targets the user configured (repos, teams). */
  listBindings(): Promise<ImporterBinding[]>;
  /** Page through importable items for one binding. */
  list(args: { binding: ImporterBinding; filters: ImporterListFilter }): Promise<ImporterListPage>;
  /** Pull one external item as a snapshot. One-shot read; the host decides create vs merge. */
  fetch(args: { externalId: string }): Promise<TrackerSnapshot>;
  /** Optional: open the external item in the default browser. */
  openExternal?(args: { externalId: string }): Promise<void>;
}
