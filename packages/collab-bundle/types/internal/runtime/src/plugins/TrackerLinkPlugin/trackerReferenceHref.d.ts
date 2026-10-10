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
import { type ConsoleTeamScope } from '@nimbalyst/collab-protocol';
/**
 * Any run of characters that is not a slash, closing paren, or whitespace,
 * excluding a bare reserved host. Kept in sync with RESERVED_LINK_HOSTS so the
 * markdown transformer and the runtime check cannot disagree.
 */
export declare const TRACKER_REFERENCE_KEY_PATTERN: string;
export declare function isTrackerReferenceKey(value: string): boolean;
/**
 * A console link to a typed page, the form new references are written in:
 * `https://console.nimbalyst.com/org/<org>/project/<project>/page/item/<KEY>`
 * (older links: `.../trackers/item/<KEY>`) for a team item, `https://console.nimbalyst.com/app/item/<KEY>` for a local
 * one. A trailing query or hash is allowed; links to pages, types and views
 * are not tracker references. `consoleLinks.ts` in collab-protocol owns the
 * shape; this pattern only finds candidates, which `trackerReferenceKeyFromHref`
 * confirms through `parseConsoleLink`.
 */
export declare const TRACKER_REFERENCE_CONSOLE_HREF_PATTERN: string;
/**
 * The reference key a link points at: `nimbalyst://KEY` (the Phase 3 form,
 * still read everywhere) or a console item link. Null for any other href.
 */
export declare function trackerReferenceKeyFromHref(href: string): string | null;
export declare function setTrackerReferenceHrefBuilder(builder: ((referenceKey: string) => string | null) | null): void;
/** The href for a new reference, or null to write the `nimbalyst://KEY` form. */
export declare function buildTrackerReferenceHref(referenceKey: string): string | null;
export declare function setTrackerReferenceHomeScope(scope: ConsoleTeamScope | null | undefined): void;
export declare function getTrackerReferenceHomeScope(): ConsoleTeamScope | null | undefined;
export declare function subscribeTrackerReferenceHomeScope(listener: () => void): () => void;
/**
 * For a host whose editors each sit in one team project (the browser): new
 * references are written as that project's console links and resolved in it
 * until the returned release. The most recent acquisition wins; releasing it
 * restores the one before.
 */
export declare function acquireConsoleReferenceScope(scope: ConsoleTeamScope): () => void;
/**
 * The team project a reference's link names when it is not `home`; null for a
 * reference this host resolves (`nimbalyst://KEY`, a local link, or its own
 * project's link).
 */
export declare function trackerReferenceForeignScope(href: string | null | undefined, home?: ConsoleTeamScope | null | undefined): ConsoleTeamScope | null;
