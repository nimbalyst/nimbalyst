/**
 * Typed pages of a Local wiki (`@nimbalyst/local-wiki` FORMAT.md) keep their
 * type and fields flat at the top of the frontmatter:
 *
 *   ---
 *   id: 01J9Z3K6V4C2W8N5QX7R1T0BHM
 *   type: competitor
 *   status: active
 *   ---
 *
 * A bare `type:` key is common in other markdown (blog front matter, static
 * site generators), so it only makes a typed page when the file is inside a
 * Local wiki folder the host registered, or when the frontmatter carries an
 * `id` and the type is a registered tracker type. Edits are written back flat.
 */
import { globalRegistry } from '@nimbalyst/tracker-schema';
import { applyFrontmatterOps, type FrontmatterOp } from './frontmatterSource';
import { EXTENSION_OWNED_KEYS, LEGACY_KEY_TO_TYPE, extractFrontmatter, type TrackerFrontmatter } from './frontmatterUtils';
import { isInLocalWikiRoot, setLocalWikiRoot } from '../../../core/localWikiRoots';

/** Frontmatter keys the wiki format reserves; every other key is a field. */
const RESERVED_KEYS = new Set(['id', 'title', 'type', 'order']);

// The registry moved to core so the agent edit policy can read it too.
export { setLocalWikiRoot, isInLocalWikiRoot };

export interface FlatTypedPage extends TrackerFrontmatter {
  /** The page's id from frontmatter, when it has one. */
  id: string | null;
}

export function detectFlatTypedPage(content: string, filePath: string): FlatTypedPage | null {
  const frontmatter = extractFrontmatter(content);
  if (!frontmatter) return null;
  const type = typeof frontmatter.type === 'string' ? frontmatter.type.trim() : '';
  if (!type) return null;
  // A wrapped tracker block is the other reader's to interpret.
  if (frontmatter.trackerStatus && typeof frontmatter.trackerStatus === 'object') return null;
  for (const key of [...Object.keys(LEGACY_KEY_TO_TYPE), ...Object.keys(EXTENSION_OWNED_KEYS)]) {
    if (frontmatter[key] && typeof frontmatter[key] === 'object') return null;
  }
  const id = typeof frontmatter.id === 'string' && frontmatter.id.trim() ? frontmatter.id : null;
  if (!isInLocalWikiRoot(filePath) && !(id && globalRegistry.get(type))) return null;
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(frontmatter)) {
    if (!RESERVED_KEYS.has(key)) data[key] = value;
  }
  return { type, data, id };
}

/** Writes field updates as top-level frontmatter keys; null or undefined removes one. */
export function updateFlatTypedPageFields(content: string, updates: Record<string, unknown>): string {
  const ops: FrontmatterOp[] = [];
  for (const [key, value] of Object.entries(updates)) {
    if (RESERVED_KEYS.has(key)) continue;
    ops.push(value === undefined || value === null ? { kind: 'delete', key } : { kind: 'set', key, value });
  }
  return ops.length > 0 ? applyFrontmatterOps(content, ops) : content;
}
