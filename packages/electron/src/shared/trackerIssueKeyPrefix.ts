export const LEGACY_ISSUE_KEY_PREFIX = 'NIM';

/**
 * Derive a compact, Linear-style issue-key prefix from a project name or path.
 * Punctuation and path separators are ignored so `stravu-editor` becomes
 * `STR`. The tracker prefix validator requires at least two letters, so names
 * that cannot provide that fall back to the historical default.
 */
export function deriveIssueKeyPrefix(projectNameOrPath: string): string {
  const projectName = projectNameOrPath
    .split(/[\\/]/)
    .filter(Boolean)
    .at(-1) ?? '';
  const letters = projectName
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z]/g, '')
    .toUpperCase();

  return letters.length >= 2 ? letters.slice(0, 3) : LEGACY_ISSUE_KEY_PREFIX;
}

/** Uppercase letter runs in a project name, longest-lived part first. */
function projectNameWords(projectNameOrPath: string): string[] {
  const projectName = projectNameOrPath
    .split(/[\\/]/)
    .filter(Boolean)
    .at(-1) ?? '';
  return projectName
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .split(/[^A-Z]+/)
    .filter(Boolean);
}

/**
 * Every prefix this project would accept, best first.
 *
 * The first choice is the plain derived prefix. After that we keep the two
 * letters that identify the project family and vary the third, taking the
 * initial of each later word before falling back to later letters and finally
 * to an alphabet sweep. That ordering is what makes a set of sibling folders
 * read sensibly: `nimbalyst-code` keeps NIM, `nimbalyst-collab` becomes NIC,
 * `nimbalyst-website` becomes NIW.
 */
function localPrefixCandidates(projectNameOrPath: string): string[] {
  const words = projectNameWords(projectNameOrPath);
  const letters = words.join('');
  if (letters.length < 2) {
    // Nothing in the name to work with -- sweep the historical default instead.
    return [LEGACY_ISSUE_KEY_PREFIX, ...alphabetSweep(LEGACY_ISSUE_KEY_PREFIX.slice(0, 2))];
  }

  const stem = letters.slice(0, 2);
  const candidates = [
    deriveIssueKeyPrefix(projectNameOrPath),
    ...words.slice(1).map((word) => stem + word[0]),
    ...letters.slice(2).split('').map((letter) => stem + letter),
    ...alphabetSweep(stem),
  ];

  return candidates.filter((candidate) => /^[A-Z]{2,5}$/.test(candidate));
}

function alphabetSweep(stem: string): string[] {
  return 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((letter) => stem + letter);
}

/**
 * Pick this project's local-number prefix, avoiding the ones already pinned by
 * other projects on this machine.
 *
 * A local number carries no other hint of where it came from, so two projects
 * sharing a prefix means `NIM.4` has more than one answer on the same machine
 * -- and agents read trackers across projects in a single session. Team
 * prefixes have the room's registry to arbitrate; local ones have only this.
 *
 * The result is pinned by the caller and never recomputed: a number already
 * handed out cannot be allowed to change meaning, so a later collision is the
 * new project's problem to route around, not this one's.
 */
export function resolveLocalKeyPrefix(params: {
  projectNameOrPath: string;
  /** Local prefixes already pinned by other projects on this machine. */
  takenPrefixes?: Iterable<string>;
  /**
   * This project's team prefix, when it has one.
   *
   * Sharing those letters leaves `NIM.42` and `NIM-42` differing by a single
   * character, and the dot is the only thing standing between a private number
   * and a shared key. A project folder named after the team is the ordinary
   * case, so the derivation avoids the collision rather than warning about it
   * afterwards. Only the automatic choice avoids it -- a user who types the
   * team prefix gets it.
   */
  avoidPrefix?: string;
}): string {
  const taken = new Set(
    Array.from(params.takenPrefixes ?? [], (prefix) => prefix.trim().toUpperCase()).filter(Boolean),
  );
  const avoid = params.avoidPrefix?.trim().toUpperCase();
  if (avoid) taken.add(avoid);
  const candidates = localPrefixCandidates(params.projectNameOrPath);
  return candidates.find((candidate) => !taken.has(candidate)) ?? candidates[0];
}
