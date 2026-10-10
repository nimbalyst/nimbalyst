/**
 * What the reference preview card says about an item beyond its chip: the
 * gist (summary, description, or the body's first paragraph), the type's most
 * telling fields, and the item's connections.
 *
 * Excerpt and fields read the record already in the runtime store. Connections
 * include body links, which only the host's relationship index knows, so the
 * host registers a {@link TrackerReferenceLinksSource}; without one the card
 * shows no connections.
 */

import type { FieldDefinition } from '@nimbalyst/tracker-schema';

import type { TrackerRecord } from '../../core/TrackerRecord';
import { globalRegistry } from '../TrackerPlugin/models';
import { formatTrackerDateCell } from '../TrackerPlugin/components/trackerColumns';
import {
  getTrackerFieldLayout,
  isTrackerFieldEmpty,
  trackerFieldDisplayLabel,
} from '../TrackerPlugin/components/trackerFieldLayout';

const EXCERPT_MAX_CHARS = 240;

/** Fields that already hold a sentence or two about the item, best first. */
const GIST_FIELDS = ['summary', 'description', 'scope'];

/** Plain text from the first prose paragraph of some markdown. */
export function markdownExcerpt(markdown: string, maxChars = EXCERPT_MAX_CHARS): string | null {
  const body = markdown.replace(/^---\n[\s\S]*?\n---\n?/, '').replace(/```[\s\S]*?```/g, '');
  for (const block of body.split(/\n\s*\n/)) {
    const lines = block.split('\n').map(line => line.trim()).filter(Boolean);
    // Headings, tables and rules say where you are, not what the item is.
    if (lines.length === 0 || /^(#|\||-{3,}|\*{3,}|<!--)/.test(lines[0])) continue;
    const text = lines
      .map(line => line.replace(/^(>\s*)+/, '').replace(/^([-*+]|\d+\.)\s+(\[[ xX]\]\s+)?/, ''))
      .join(' ')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]+>/g, '')
      .replace(/(\*\*|__|\*|_|~~|`)(\S(?:.*?\S)?)\1/g, '$2')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) continue;
    return text.length > maxChars ? `${text.slice(0, maxChars - 1).trimEnd()}…` : text;
  }
  return null;
}

function contentMarkdown(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object') {
    const markdown = (content as { markdown?: unknown }).markdown;
    if (typeof markdown === 'string') return markdown;
  }
  return null;
}

/** A sentence or two saying what the item is, or null when it has none. */
export function trackerReferenceExcerpt(record: TrackerRecord): string | null {
  for (const name of GIST_FIELDS) {
    const value = record.fields[name];
    if (typeof value === 'string' && value.trim()) {
      const excerpt = markdownExcerpt(value);
      if (excerpt) return excerpt;
    }
  }
  const markdown = contentMarkdown(record.content);
  return markdown ? markdownExcerpt(markdown) : null;
}

export interface TrackerReferenceKeyField {
  name: string;
  label: string;
  value: string;
  /** Exact value when `value` is a relative or abbreviated form. */
  title?: string;
}

/** Roles the card header and footer already show. */
const SHOWN_ELSEWHERE_ROLES = ['workflowStatus', 'priority', 'assignee'] as const;

/** Prose belongs in the excerpt; links belong in Connections. */
const KEY_FIELD_SKIPPED_TYPES = new Set(['text', 'relationship', 'reference', 'citation']);

function formatFieldValue(field: FieldDefinition, value: unknown): { value: string; title?: string } | null {
  if (Array.isArray(value)) {
    const parts = value
      .map(entry => formatFieldValue(field, entry)?.value)
      .filter((entry): entry is string => Boolean(entry));
    return parts.length ? { value: parts.join(', ') } : null;
  }
  if (field.type === 'date' || field.type === 'datetime') {
    const { display, title } = formatTrackerDateCell(value);
    return display ? { value: display, title: title || undefined } : null;
  }
  if (field.type === 'boolean' || typeof value === 'boolean') return { value: value ? 'Yes' : 'No' };
  if (field.options?.length) {
    const option = field.options.find(candidate => candidate.value === value);
    if (option) return { value: option.label };
  }
  if (value && typeof value === 'object') {
    const { label, url } = value as { label?: unknown; url?: unknown };
    const text = typeof label === 'string' && label ? label : typeof url === 'string' ? url : null;
    return text ? { value: text } : null;
  }
  if (field.type === 'url' && typeof value === 'string') {
    try {
      return { value: new URL(value).hostname.replace(/^www\./, ''), title: value };
    } catch {
      return { value };
    }
  }
  return { value: String(value) };
}

/**
 * The type's first few filled-in fields, in the order every tracker surface
 * uses (roles first, then schema order), minus what the card already shows.
 */
export function trackerReferenceKeyFields(record: TrackerRecord, max = 3): TrackerReferenceKeyField[] {
  const model = globalRegistry.get(record.primaryType);
  const shown = new Set<string>();
  for (const role of SHOWN_ELSEWHERE_ROLES) {
    const name = model?.roles?.[role];
    if (name) shown.add(name);
  }
  shown.add('status').add('priority').add('owner');
  for (const name of GIST_FIELDS) shown.add(name);

  const result: TrackerReferenceKeyField[] = [];
  for (const field of getTrackerFieldLayout(record.primaryType)) {
    if (result.length >= max) break;
    if (shown.has(field.name) || KEY_FIELD_SKIPPED_TYPES.has(field.type) || field.predicate) continue;
    const raw = record.fields[field.name];
    if (isTrackerFieldEmpty(raw)) continue;
    const formatted = formatFieldValue(field, raw);
    if (!formatted) continue;
    result.push({ name: field.name, label: trackerFieldDisplayLabel(field), ...formatted });
  }
  return result;
}

export interface TrackerReferenceLinkedItem {
  itemId: string;
  title: string;
  typeId: string;
}

/** Links under the label they read as from this item: "Mentioned in", "Competes with". */
export interface TrackerReferenceLinkGroup {
  label: string;
  items: TrackerReferenceLinkedItem[];
}

export interface TrackerReferenceLinksSource {
  /** Both directions, grouped. Null when the links cannot be read right now. */
  linkGroupsFor(itemId: string, itemType: string | undefined): Promise<TrackerReferenceLinkGroup[] | null>;
}

let linksSource: TrackerReferenceLinksSource | null = null;

/** The host's relationship index; null removes it. */
export function setTrackerReferenceLinksSource(source: TrackerReferenceLinksSource | null): void {
  linksSource = source;
}

export function getTrackerReferenceLinksSource(): TrackerReferenceLinksSource | null {
  return linksSource;
}
