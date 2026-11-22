/**
 * What a reader outside the wiki's authors must not see, shared by the static
 * export (`exportSite.ts`) and the team publish (`localWiki/publishToTeam.ts`):
 * pages opted out with `export: false` (and everything under them), and person
 * fields (owner, assignee, author and the like, a type's `user` fields, and any
 * value that is an email address).
 */

const IDENTITY_FIELD = /^(owners?|assignees?|authors?|reporters?|created_?by|updated_?by|emails?|contacts?|members?)$/i;
const EMAIL = /[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}/i;

function hasEmail(value: unknown): boolean {
  if (typeof value === 'string') return EMAIL.test(value);
  if (Array.isArray(value)) return value.some(hasEmail);
  return false;
}

/** `export: false` in a page's frontmatter (YAML may hand it over as a string). */
export function isExportOptOut(fields: Record<string, unknown>): boolean {
  return fields.export === false || fields.export === 'false';
}

/** Fields with person fields removed; `userFields` are the type's `user` fields. */
export function stripIdentity(fields: Record<string, unknown>, userFields: ReadonlySet<string>, keep = false): { fields: Record<string, unknown>; removed: number } {
  if (keep) return { fields, removed: 0 };
  const out: Record<string, unknown> = {};
  let removed = 0;
  for (const [name, value] of Object.entries(fields)) {
    if (IDENTITY_FIELD.test(name) || userFields.has(name) || hasEmail(value)) removed++;
    else out[name] = value;
  }
  return { fields: out, removed };
}
