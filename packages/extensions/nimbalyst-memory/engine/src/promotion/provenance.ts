/**
 * Provenance that survives leaving the machine.
 *
 * A promoted rule has to let a reader find where it came from, and the obvious
 * way to do that is the wrong one. Tracker issue keys (`NIM-2374`) are scoped
 * to a single workspace's tracker room: the same key in another checkout points
 * at an unrelated item, so a reader who follows it lands somewhere wrong and
 * believes it is authoritative. That makes a key in a committed file worse than
 * no citation at all. GitHub issue numbers are global to the repository and are
 * the citation form that travels; failing that, the reason goes in prose.
 *
 * So the promoter strips tracker keys rather than trusting the mined text not
 * to contain them, and reports every removal as a warning the reviewer sees in
 * the preview — the sentence usually needs rewriting once its citation is gone,
 * and that judgement is theirs.
 */

/**
 * Default tracker key prefixes to strip. The workspace prefix is configurable,
 * so callers with a non-default prefix pass their own list; `NIM` is here
 * because it is this codebase's and it is what mined text actually contains.
 */
export const DEFAULT_TRACKER_KEY_PREFIXES = ['NIM', 'STR'];

/** One removed citation, with enough context for a human to rewrite the line. */
export interface TrackerKeyRemoval {
  key: string;
  /** The sentence the key was removed from, after removal. */
  context: string;
}

export interface StripResult {
  text: string;
  removals: TrackerKeyRemoval[];
}

const escapeForRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Build the key matcher from an explicit prefix list rather than a generic
 * `[A-Z]+-\d+` pattern, which eats real prose (`UTF-8`, `SHA-256`, `HTTP-2`).
 */
function keyPattern(prefixes: readonly string[]): RegExp | null {
  const usable = prefixes.filter((prefix) => /^[A-Z][A-Z0-9]*$/.test(prefix));
  if (usable.length === 0) return null;
  return new RegExp(`\\b(?:${usable.map(escapeForRegExp).join('|')})-\\d+\\b`, 'g');
}

/**
 * Remove tracker keys and the citation scaffolding around them, then tidy the
 * punctuation the removal leaves behind. Conservative on purpose: it deletes
 * the reference, never rewrites the surrounding claim.
 */
export function stripTrackerKeys(
  text: string,
  prefixes: readonly string[] = DEFAULT_TRACKER_KEY_PREFIXES,
): StripResult {
  const pattern = keyPattern(prefixes);
  if (!pattern || !text) return { text, removals: [] };

  const found = text.match(pattern);
  if (!found) return { text, removals: [] };

  const removals = Array.from(new Set(found)).map((key) => ({
    key,
    context: cleanedSentenceFor(text, key, pattern),
  }));

  return { text: removeKeys(text, pattern), removals };
}

/** The removal itself, free of any context-building so it cannot recurse. */
function removeKeys(text: string, pattern: RegExp): string {
  const keyAlt = pattern.source;
  return tidyAfterRemoval(
    text
      // `(see NIM-1)`, `(NIM-1)`, `[NIM-1]` — the whole parenthetical goes.
      .replace(
        new RegExp(`\\s*[([]\\s*(?:see|per|from|tracked in|tracker)?\\s*${keyAlt}\\s*[)\\]]`, 'g'),
        '',
      )
      // `, see NIM-1` / `; per NIM-1` mid-sentence.
      .replace(new RegExp(`[,;]?\\s*(?:see|per|from|tracked in)\\s+${keyAlt}`, 'g'), '')
      // Anything left, including a bare key used as a noun.
      .replace(new RegExp(keyAlt, 'g'), ''),
  );
}

/** Collapse the whitespace and orphaned punctuation a deletion leaves behind. */
function tidyAfterRemoval(text: string): string {
  return text
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\(\s*\)|\[\s*\]/g, '')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/([([])\s+/g, '$1')
    .replace(/[ \t]+$/gm, '');
}

/**
 * The sentence the key lived in, as it will read once the key is gone. Located
 * in the original text (where the key is still there to find) and cleaned
 * afterwards, because positions shift as soon as anything is removed.
 */
function cleanedSentenceFor(original: string, key: string, pattern: RegExp): string {
  const index = original.indexOf(key);
  if (index < 0) return '';
  const before = original.slice(0, index);
  const start = Math.max(
    before.lastIndexOf('. '),
    before.lastIndexOf('\n'),
    before.lastIndexOf('! '),
    before.lastIndexOf('? '),
  );
  const rest = original.slice(start < 0 ? 0 : start + 1);
  const end = rest.search(/[.!?](\s|$)/);
  const sentence = end < 0 ? rest : rest.slice(0, end + 1);
  return removeKeys(sentence.trim(), pattern).trim();
}

/**
 * Throw if a tracker key survived. This is an internal invariant, not a user
 * condition: the whole point of the feature is that a promoted file never
 * carries a reference that resolves to the wrong thing somewhere else, so a
 * leak is a bug in the stripper and must not reach a write.
 */
export function assertNoTrackerKeys(
  text: string,
  prefixes: readonly string[] = DEFAULT_TRACKER_KEY_PREFIXES,
): void {
  const pattern = keyPattern(prefixes);
  const leaked = pattern ? text.match(pattern) : null;
  if (leaked) {
    throw new Error(
      `Refusing to promote: tracker key ${leaked[0]} survived into the rule text. ` +
        'Tracker keys resolve to unrelated items outside this workspace.',
    );
  }
}

/** `[1347, 88]` -> `GitHub #1347 and #88`, for a citation sentence. */
export function formatIssueCitation(issues: readonly number[]): string {
  const valid = issues.filter((n) => Number.isInteger(n) && n > 0);
  if (valid.length === 0) return '';
  const refs = valid.map((n) => `#${n}`);
  if (refs.length === 1) return `GitHub ${refs[0]}`;
  const last = refs.pop() as string;
  return `GitHub ${refs.join(', ')} and ${last}`;
}
