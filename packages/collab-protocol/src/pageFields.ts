/**
 * A plain page's own fields, as every store and the wire carry them: Personal
 * pages on desktop, Team pages in the TeamRoom's document index, and the web
 * console. The schema is fixed in code, so the wire carries only values.
 *
 * `normalizePageFields` is the one validation gate every read and write goes
 * through, on clients and on the sync server alike: unknown keys and wrong
 * shapes are dropped, never stored. Pure and dependency-free.
 */

export type PageStatus = 'draft' | 'current' | 'outdated';

export interface PageFields {
  /** Who keeps the page current: an email, as a tracker `user` field holds. */
  owner?: string;
  status?: PageStatus;
  /** One line: what the page is for. Shown in Search and link hovers. */
  summary?: string;
  tags?: string[];
}

export const PAGE_STATUSES: readonly PageStatus[] = ['draft', 'current', 'outdated'];

export const PAGE_FIELDS_MAX_TAGS = 32;
export const PAGE_FIELDS_MAX_TEXT = 280;

/** Shape only: one `@`, something on both sides, no spaces. Membership is not checked. */
const EMAIL = /^[^\s@]+@[^\s@]+$/;

/**
 * The stored shape of `value`, or `{}`. Empty values are dropped, so "cleared"
 * and "never set" are the same thing on the wire.
 */
export function normalizePageFields(value: unknown): PageFields {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const fields: PageFields = {};
  const text = (input: unknown) => (typeof input === 'string' ? input.trim().slice(0, PAGE_FIELDS_MAX_TEXT) : '');
  const owner = text(raw.owner);
  if (owner && EMAIL.test(owner)) fields.owner = owner;
  if (typeof raw.status === 'string' && (PAGE_STATUSES as readonly string[]).includes(raw.status)) {
    fields.status = raw.status as PageStatus;
  }
  const summary = text(raw.summary);
  if (summary) fields.summary = summary;
  if (Array.isArray(raw.tags)) {
    const tags = [...new Set(raw.tags.map(text).filter(Boolean))].slice(0, PAGE_FIELDS_MAX_TAGS);
    if (tags.length > 0) fields.tags = tags;
  }
  return fields;
}

/**
 * `current` with `patch` applied. A null or empty value clears that field; a
 * value that doesn't validate is ignored, so a bad write never erases a good one.
 */
export function applyPageFieldsPatch(current: PageFields | undefined, patch: Record<string, unknown>): PageFields {
  const merged: Record<string, unknown> = { ...normalizePageFields(current) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined || value === '') {
      delete merged[key];
      continue;
    }
    const valid = normalizePageFields({ [key]: value }) as Record<string, unknown>;
    if (key in valid) merged[key] = valid[key];
  }
  return normalizePageFields(merged);
}

export function samePageFields(left: PageFields | undefined, right: PageFields | undefined): boolean {
  const a = normalizePageFields(left);
  const b = normalizePageFields(right);
  return a.owner === b.owner && a.status === b.status && a.summary === b.summary
    && (a.tags ?? []).join('\u0000') === (b.tags ?? []).join('\u0000');
}
