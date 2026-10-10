/**
 * Which `nimbalyst://<rest>` hrefs are tracker references.
 *
 * Tracker keys take several real shapes, so an allowlist of key *patterns* is
 * not viable: issue keys (`NIM-123`), type-prefixed record ids
 * (`bug_01JBKZ...`, `github-pr_...`, `decision-exploration_...`), and
 * frontmatter-projected ids (`fm:plan:planning/foo.md`). The tracker picker
 * inserts `record.issueKey ?? record.id`, so any item without an allocated
 * issue key is referenced by its raw id — those exist in real databases.
 *
 * The reliable discriminator is the slash: every other `nimbalyst://`
 * namespace is `host/path` (`action/open-project-manager`, `doc/<id>`,
 * `folder/<id>`, `tracker/<id>`, `install/<extId>`, `auth/callback`), while a
 * tracker key never contains one. Reserved hosts are also rejected bare so a
 * future `nimbalyst://action` with no path cannot be mistaken for a key.
 */

import { buildConsoleLink, CONSOLE_LINK_ORIGIN, parseConsoleLink, type ConsoleTeamScope } from '@nimbalyst/collab-protocol';

/** Hosts owned by the deep-link router; never tracker keys. */
const RESERVED_LINK_HOSTS = new Set([
  'action',
  'auth',
  'console',
  'doc',
  'folder',
  'install',
  'tracker',
]);

/**
 * Any run of characters that is not a slash, closing paren, or whitespace,
 * excluding a bare reserved host. Kept in sync with RESERVED_LINK_HOSTS so the
 * markdown transformer and the runtime check cannot disagree.
 */
export const TRACKER_REFERENCE_KEY_PATTERN = `(?!(?:${[...RESERVED_LINK_HOSTS].join('|')})(?=[)\\s]|$))[^)\\s/]+`;

const TRACKER_REFERENCE_KEY_RE = new RegExp(
  `^${TRACKER_REFERENCE_KEY_PATTERN}$`,
);

export function isTrackerReferenceKey(value: string): boolean {
  if (!TRACKER_REFERENCE_KEY_RE.test(value)) return false;
  return !RESERVED_LINK_HOSTS.has(value.toLowerCase());
}

const URN_SCHEME = 'nimbalyst://';
const URL_SEGMENT = String.raw`[^/\s()"?#]+`;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A console link to a typed page, the form new references are written in:
 * `https://console.nimbalyst.com/org/<org>/project/<project>/page/item/<KEY>`
 * (older links: `.../trackers/item/<KEY>`) for a team item, `https://console.nimbalyst.com/app/item/<KEY>` for a local
 * one. A trailing query or hash is allowed; links to pages, types and views
 * are not tracker references. `consoleLinks.ts` in collab-protocol owns the
 * shape; this pattern only finds candidates, which `trackerReferenceKeyFromHref`
 * confirms through `parseConsoleLink`.
 */
export const TRACKER_REFERENCE_CONSOLE_HREF_PATTERN = `${escapeRegExp(CONSOLE_LINK_ORIGIN)}/(?:org/${URL_SEGMENT}/project/${URL_SEGMENT}/(?:page|trackers)/item|app/item)/${URL_SEGMENT}(?:[?#][^\\s()"]*)?`;

/**
 * The reference key a link points at: `nimbalyst://KEY` (the Phase 3 form,
 * still read everywhere) or a console item link. Null for any other href.
 */
export function trackerReferenceKeyFromHref(href: string): string | null {
  const trimmed = href.trim();
  if (trimmed.startsWith(URN_SCHEME)) {
    const key = trimmed.slice(URN_SCHEME.length);
    return isTrackerReferenceKey(key) ? key : null;
  }
  const target = parseConsoleLink(trimmed);
  return target?.kind === 'item' ? target.itemRef : null;
}

/**
 * Builds the link a newly created reference is written with. The host
 * registers it once it knows its team (the console link to the item);
 * without one, a new reference is written as `nimbalyst://KEY`.
 */
let hrefBuilder: ((referenceKey: string) => string | null) | null = null;

export function setTrackerReferenceHrefBuilder(builder: ((referenceKey: string) => string | null) | null): void {
  hrefBuilder = builder;
}

/** The href for a new reference, or null to write the `nimbalyst://KEY` form. */
export function buildTrackerReferenceHref(referenceKey: string): string | null {
  return hrefBuilder?.(referenceKey) ?? null;
}

/**
 * The team project this host resolves references in: an issue key is only
 * unique within one, so a console link naming any other project must never be
 * resolved to this project's item with the same key. Undefined until the host
 * says (null: it has no team project), and every team link is then foreign.
 */
let homeScope: ConsoleTeamScope | null | undefined;
const homeScopeListeners = new Set<() => void>();

export function setTrackerReferenceHomeScope(scope: ConsoleTeamScope | null | undefined): void {
  if (scope === homeScope || (scope && homeScope && scope.orgId === homeScope.orgId && scope.projectId === homeScope.projectId)) return;
  homeScope = scope;
  for (const listener of [...homeScopeListeners]) listener();
}

export function getTrackerReferenceHomeScope(): ConsoleTeamScope | null | undefined {
  return homeScope;
}

export function subscribeTrackerReferenceHomeScope(listener: () => void): () => void {
  homeScopeListeners.add(listener);
  return () => homeScopeListeners.delete(listener);
}

const acquiredScopes: Array<{ scope: ConsoleTeamScope }> = [];

function applyAcquiredScope(): void {
  const top = acquiredScopes[acquiredScopes.length - 1];
  if (!top) {
    setTrackerReferenceHrefBuilder(null);
    setTrackerReferenceHomeScope(undefined);
    return;
  }
  const { scope } = top;
  setTrackerReferenceHrefBuilder((referenceKey) => buildConsoleLink({ kind: 'item', scope, itemRef: referenceKey }));
  setTrackerReferenceHomeScope(scope);
}

/**
 * For a host whose editors each sit in one team project (the browser): new
 * references are written as that project's console links and resolved in it
 * until the returned release. The most recent acquisition wins; releasing it
 * restores the one before.
 */
export function acquireConsoleReferenceScope(scope: ConsoleTeamScope): () => void {
  const entry = { scope };
  acquiredScopes.push(entry);
  applyAcquiredScope();
  return () => {
    const index = acquiredScopes.indexOf(entry);
    if (index === -1) return;
    acquiredScopes.splice(index, 1);
    applyAcquiredScope();
  };
}

/**
 * The team project a reference's link names when it is not `home`; null for a
 * reference this host resolves (`nimbalyst://KEY`, a local link, or its own
 * project's link).
 */
export function trackerReferenceForeignScope(
  href: string | null | undefined,
  home: ConsoleTeamScope | null | undefined = homeScope,
): ConsoleTeamScope | null {
  const target = parseConsoleLink(href);
  if (target?.kind !== 'item' || target.scope === 'local') return null;
  if (home && home.orgId === target.scope.orgId && home.projectId === target.scope.projectId) return null;
  return target.scope;
}
