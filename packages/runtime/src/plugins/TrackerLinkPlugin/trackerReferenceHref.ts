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

/** Hosts owned by the deep-link router; never tracker keys. */
const RESERVED_LINK_HOSTS = new Set([
  'action',
  'auth',
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
export const TRACKER_REFERENCE_KEY_PATTERN = `(?!(?:${[...RESERVED_LINK_HOSTS].join('|')})\\))[^)\\s/]+`;

const TRACKER_REFERENCE_KEY_RE = new RegExp(
  `^${TRACKER_REFERENCE_KEY_PATTERN}$`,
);

export function isTrackerReferenceKey(value: string): boolean {
  if (!TRACKER_REFERENCE_KEY_RE.test(value)) return false;
  return !RESERVED_LINK_HOSTS.has(value.toLowerCase());
}
