/**
 * Utilities for detecting and parsing tracker frontmatter
 */

import jsyaml from 'js-yaml';
import { globalRegistry } from '../models/TrackerDataModel';
import { parseDate, formatLocalDateOnly } from '../models/dateUtils';

export interface TrackerFrontmatter {
  type: string; // Tracker type (plan, decision, bug, etc.)
  data: Record<string, any>; // All tracker field data
}

/**
 * Resolve tracker field data from merged frontmatter using the model's field definitions.
 * Handles date fallback ('date' -> 'publishDate') and parses date values.
 */
function resolveFieldData(type: string, data: Record<string, any>): Record<string, any> {
  const model = globalRegistry.get(type);
  if (!model) return data;

  const resolved = { ...data };
  for (const field of model.fields) {
    // If the field value is missing, check the 'date' key as fallback for date fields
    if (resolved[field.name] === undefined && (field.type === 'date' || field.type === 'datetime')) {
      if (resolved.date !== undefined) {
        resolved[field.name] = resolved.date;
      }
    }
    // Parse date values into proper Date objects
    if ((field.type === 'date' || field.type === 'datetime') && resolved[field.name] !== undefined) {
      const parsed = parseDate(resolved[field.name]);
      if (parsed) {
        resolved[field.name] = parsed;
      }
    }
  }
  return resolved;
}

/**
 * Extract YAML frontmatter from markdown content.
 *
 * `\r?\n` tolerates Windows `\r\n` line endings (e.g. files checked out
 * with `git config core.autocrlf=true`). Without it, frontmatter on
 * Windows-newline files is silently undetectable. See nimbalyst#68.
 */
export function extractFrontmatter(content: string): Record<string, any> | null {
  const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---/;
  const match = content.match(frontmatterRegex);

  if (!match) {
    return null;
  }

  try {
    const yamlContent = match[1];
    const parsed = jsyaml.load(yamlContent) as Record<string, any>;
    return parsed || null;
  } catch (error) {
    console.error('[TrackerPlugin] Failed to parse frontmatter:', error);
    return null;
  }
}

/**
 * Legacy frontmatter key -> tracker type mapping.
 * These keys were used before the unified `trackerStatus` format.
 */
export const LEGACY_KEY_TO_TYPE: Record<string, string> = {
  planStatus: 'plan',
  decisionStatus: 'decision',
  bugStatus: 'bug',
  taskStatus: 'task',
  ideaStatus: 'idea',
};

/**
 * Extension-owned frontmatter keys that the tracker should detect but never flatten or rewrite.
 * The owning extension manages these blocks; the tracker only reads `type` from their presence.
 *
 * Exported so consumers like `TrackerTable.resolveTrackerFrontmatter` can use the same map
 * and stay in sync with `detectTrackerFromFrontmatter` instead of duplicating it. See
 * nimbalyst#67 for the consequences of having two diverging copies.
 */
export const EXTENSION_OWNED_KEYS: Record<string, string> = {
  automationStatus: 'automation',
};

/**
 * Canonical public ID for a full-document tracker item backed by a file.
 * Shared by renderer, main-process services, and MCP-facing code so plan /
 * decision / other full-document items resolve to the same identifier
 * everywhere, even if the backing projection row in `tracker_items` uses an
 * older legacy ID.
 */
export function buildFullDocumentTrackerId(trackerType: string, relativePath: string): string {
  return `fm:${trackerType}:${relativePath}`;
}

/**
 * Parse a canonical full-document tracker ID back into its tracker type and
 * workspace-relative file path.
 */
export function parseFullDocumentTrackerId(
  itemId: string,
): { trackerType: string; relativePath: string } | null {
  const match = /^fm:([^:]+):(.+)$/.exec(itemId);
  if (!match) return null;
  return {
    trackerType: match[1],
    relativePath: match[2],
  };
}

/**
 * Detect tracker type and data from frontmatter.
 *
 * Checks generic `trackerStatus` first (the canonical format), then falls
 * back to legacy per-type keys (`planStatus`, `decisionStatus`, `automationStatus`)
 * for backward compatibility with existing files.
 */
export function detectTrackerFromFrontmatter(content: string): TrackerFrontmatter | null {
  const frontmatter = extractFrontmatter(content);
  if (!frontmatter) {
    return null;
  }

  // Extension-owned keys take priority -- their extension manages the nested block,
  // so always read from it rather than stale top-level fields. Top-level fields
  // are still surfaced when they don't shadow a nested field (e.g. tracker
  // workflow `status` and `tags`, which the nested AutomationStatus block does
  // not own). The nested block wins on overlap to defeat any stale duplicates
  // left over by previous flattening.
  for (const [extKey, trackerType] of Object.entries(EXTENSION_OWNED_KEYS)) {
    if (frontmatter[extKey] && typeof frontmatter[extKey] === 'object') {
      const extData = frontmatter[extKey] as Record<string, any>;
      const { [extKey]: _, trackerStatus: _ts, ...otherTopLevel } = frontmatter;
      const merged = { ...otherTopLevel, ...extData, type: trackerType };
      return {
        type: trackerType,
        data: resolveFieldData(trackerType, merged),
      };
    }
  }

  // Check for trackerStatus with type field (canonical format)
  if (frontmatter.trackerStatus && typeof frontmatter.trackerStatus === 'object') {
    const trackerData = frontmatter.trackerStatus as Record<string, any>;
    if (trackerData.type) {
      // Top-level fields are canonical. trackerStatus holds only `type`.
      const { trackerStatus: _, ...topLevelFields } = frontmatter;
      const merged = { ...trackerData, ...topLevelFields };
      return {
        type: trackerData.type as string,
        data: resolveFieldData(trackerData.type as string, merged),
      };
    }
  }

  // Legacy fallback: check for per-type keys (planStatus, decisionStatus, etc.)
  for (const [legacyKey, trackerType] of Object.entries(LEGACY_KEY_TO_TYPE)) {
    if (frontmatter[legacyKey] && typeof frontmatter[legacyKey] === 'object') {
      const legacyData = frontmatter[legacyKey] as Record<string, any>;
      // Legacy format nests all fields under the key; extract to top level
      const { [legacyKey]: _, ...otherTopLevel } = frontmatter;
      const merged = { ...legacyData, ...otherTopLevel, type: trackerType };
      return {
        type: trackerType,
        data: resolveFieldData(trackerType, merged),
      };
    }
  }

  return null;
}

/**
 * Update frontmatter in markdown content
 */
export function updateFrontmatter(
  content: string,
  updates: Record<string, any>
): string {
  const frontmatter = extractFrontmatter(content) || {};
  const updated = { ...frontmatter, ...updates };

  const yamlContent = jsyaml.dump(updated, {
    indent: 2,
    lineWidth: -1, // Don't wrap lines
    noRefs: true,
  });

  // `\r?\n` matches both LF and CRLF openers (nimbalyst#68).
  const frontmatterRegex = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;
  const hasFrontmatter = frontmatterRegex.test(content);

  if (hasFrontmatter) {
    // Replace existing frontmatter
    return content.replace(frontmatterRegex, `---\n${yamlContent}---\n`);
  } else {
    // Add frontmatter at the beginning
    return `---\n${yamlContent}---\n${content}`;
  }
}

/**
 * Update specific tracker data in frontmatter.
 * Migrates legacy keys (planStatus, decisionStatus, etc.) to canonical trackerStatus on save.
 */
export function updateTrackerInFrontmatter(
  content: string,
  trackerType: string,
  updates: Record<string, any>
): string {
  const frontmatter = extractFrontmatter(content) || {};

  // Extension-owned keys are managed by their respective extensions -- never
  // flatten or rewrite the nested block. Only mutate top-level fields the
  // extension does not own (e.g. tracker workflow `status`, `tags`, timestamps),
  // and clean up any stale top-level duplicates of nested fields that previous
  // tracker code may have written before this fix landed.
  const extensionOwnedKey = Object.keys(EXTENSION_OWNED_KEYS).find(
    key => frontmatter[key] && typeof frontmatter[key] === 'object'
  );
  if (extensionOwnedKey) {
    const nestedData = frontmatter[extensionOwnedKey] as Record<string, any>;
    const nestedFieldNames = new Set(Object.keys(nestedData));

    const topLevel: Record<string, any> = {};
    for (const [key, value] of Object.entries(frontmatter)) {
      if (key === extensionOwnedKey) continue;
      if (key === 'trackerStatus') continue;
      if (nestedFieldNames.has(key)) continue; // drop stale duplicate
      topLevel[key] = value;
    }

    // Apply caller updates targeting top-level tracker fields. Updates aimed at
    // fields the nested block owns are dropped here -- the owning extension is
    // the only writer for those fields.
    for (const [key, value] of Object.entries(updates)) {
      if (key === 'type') continue;
      if (nestedFieldNames.has(key)) continue;
      topLevel[key] = value;
    }

    const now = formatLocalDateOnly(new Date());
    if (!topLevel.created) topLevel.created = now;
    topLevel.updated = now;

    const mergedUpdates: Record<string, any> = {
      ...topLevel,
      [extensionOwnedKey]: nestedData,
      trackerStatus: { type: trackerType },
    };

    const yamlContent = jsyaml.dump(mergedUpdates, {
      indent: 2,
      lineWidth: -1,
      noRefs: true,
    });
    // `\r?\n` matches both LF and CRLF openers (nimbalyst#68).
    const frontmatterRegex = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;
    if (frontmatterRegex.test(content)) {
      return content.replace(frontmatterRegex, `---\n${yamlContent}---\n`);
    }
    return `---\n${yamlContent}---\n${content}`;
  }

  // Migrate: remove any legacy key, promote its fields to top level
  let legacyFields: Record<string, any> = {};
  for (const legacyKey of Object.keys(LEGACY_KEY_TO_TYPE)) {
    if (frontmatter[legacyKey] && typeof frontmatter[legacyKey] === 'object') {
      legacyFields = { ...(frontmatter[legacyKey] as Record<string, any>) };
      delete frontmatter[legacyKey];
    }
  }

  // Always use trackerStatus (canonical format).
  // trackerStatus holds only `type`. All other fields go at the top level.
  const existingTracker = (frontmatter.trackerStatus || {}) as Record<string, any>;

  const topLevelUpdates: Record<string, any> = {};
  const trackerStatusData: Record<string, any> = { type: existingTracker.type || trackerType };

  // Apply legacy fields first (lowest priority), then explicit updates
  for (const [key, value] of Object.entries(legacyFields)) {
    if (key === 'type') {
      // Legacy doesn't have a 'type' field; skip
    } else {
      topLevelUpdates[key] = value;
    }
  }

  for (const [key, value] of Object.entries(updates)) {
    if (key === 'type') {
      trackerStatusData.type = value;
    } else {
      topLevelUpdates[key] = value;
    }
  }

  const now = formatLocalDateOnly(new Date());
  if (!frontmatter.created && !topLevelUpdates.created) {
    topLevelUpdates.created = now;
  }
  topLevelUpdates.updated = now;

  return updateFrontmatter(content, {
    ...topLevelUpdates,
    trackerStatus: trackerStatusData,
  });
}

/**
 * Update an inline tracker item in file content.
 * Finds a line matching `... #type[id:ITEM_ID ...]` and rewrites the metadata fields.
 * Returns the updated content, or null if the item was not found.
 */
/**
 * Item/record field names that map to a different key in the compact inline
 * `#type[...]` marker grammar. The re-scan parser reads the marker key (e.g.
 * `due`), so the serializer must write that key, not the UI field name (e.g.
 * `dueDate`). Without this a due-date edit is written as `dueDate:` and dropped
 * on the next scan (GitHub #404).
 */
export const INLINE_FIELD_TO_MARKER_KEY: Record<string, string> = {
  dueDate: 'due',
};

/**
 * Normalize a marker's leading text to the same shape the indexer stores as the
 * item title (strip a list/checkbox prefix, collapse whitespace, lowercase).
 * Used to locate id-less markers by title.
 */
function normalizeInlineTitleForMatch(title: string): string {
  return title
    .replace(/^- /, '')
    .replace(/^\[ \] /, '')
    .replace(/^\[x\] /, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

export function updateInlineTrackerItem(
  content: string,
  itemId: string,
  updates: Record<string, any>,
  fallbackLocator?: { lineNumber?: number; title?: string }
): string | null {
  const lines = content.split('\n');
  let found = false;

  // Match lines like: Some title #bug[id:bug_abc123 status:to-do priority:high]
  const inlineRegex = new RegExp(
    `^(.+?)\\s+#([a-z][\\w-]*)\\[(.+?)\\](.*)$`
  );

  const hasFallback =
    fallbackLocator != null &&
    (fallbackLocator.lineNumber != null || fallbackLocator.title != null);

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(inlineRegex);
    if (!match) continue;

    const [, textContent, type, propsStr, trailing] = match;

    // Parse existing props to identify this marker.
    const props = parseInlineProps(propsStr);

    // Explicit-id markers match by id. Id-less markers (their id is a
    // deterministic hash that never reaches the file) fall back to a line +
    // title match supplied by the caller; both provided signals must agree, so
    // a drifted file fails to a no-op rather than editing the wrong marker.
    let isMatch: boolean;
    if (props.id) {
      isMatch = props.id === itemId;
    } else if (hasFallback) {
      // Id-less markers: require the marker type, line, and title to all agree.
      // An id-less item's id is a deterministic `${type}_${hash}`, so the marker
      // type must match the itemId prefix. Requiring all three avoids editing the
      // wrong marker after the file has drifted.
      const typeOk = itemId.startsWith(`${type}_`);
      const lineOk =
        fallbackLocator!.lineNumber != null && fallbackLocator!.lineNumber === i + 1;
      const titleOk =
        fallbackLocator!.title != null &&
        normalizeInlineTitleForMatch(textContent) ===
          normalizeInlineTitleForMatch(fallbackLocator!.title);
      isMatch = typeOk && lineOk && titleOk;
    } else {
      isMatch = false;
    }
    if (!isMatch) continue;

    // Apply updates, mapping item field names to their inline marker key.
    for (const [key, value] of Object.entries(updates)) {
      if (key === 'title') {
        // Title is the text before #type[...], handled separately below
        continue;
      }
      if (key === 'description') {
        // An inline item's description lives in the indented block below the
        // marker, not as a marker prop. Writing it here would pollute the marker
        // and be ignored by the re-scan parser, so leave it out.
        continue;
      }
      const markerKey = INLINE_FIELD_TO_MARKER_KEY[key] ?? key;
      if (markerKey !== key) {
        // Drop any stale prop written under the UI field name (e.g. a previously
        // mis-written `dueDate:`) so it cannot shadow the canonical marker key.
        delete props[key];
      }
      if (value === null || value === undefined) {
        // Remove the prop when set to null/undefined
        delete props[markerKey];
      } else {
        props[markerKey] = value;
      }
    }

    // Update the 'updated' timestamp
    props.updated = new Date().toISOString().split('T')[0];

    // Rebuild the props string
    const newPropsStr = serializeInlineProps(props);

    // Rebuild the line (use updated title if provided)
    const title = updates.title ?? textContent.trim();
    lines[i] = `${title} #${type}[${newPropsStr}]${trailing}`;
    found = true;
    break;
  }

  return found ? lines.join('\n') : null;
}

/**
 * Remove an inline tracker item line from file content.
 * Returns updated content with the matching line removed, or null if not found.
 */
export function removeInlineTrackerItem(content: string, itemId: string): string | null {
  const lines = content.split('\n');
  const inlineRegex = /^(.+?)\s+#([a-z][\w-]*)\[(.+?)\](.*)$/;

  const nextLines = lines.filter(line => {
    const match = line.match(inlineRegex);
    if (!match) return true;
    const props = parseInlineProps(match[3]);
    return props.id !== itemId;
  });

  if (nextLines.length === lines.length) return null; // not found
  return nextLines.join('\n');
}

/** Parse key:value pairs from inline tracker metadata string */
function parseInlineProps(propsStr: string): Record<string, string> {
  const props: Record<string, string> = {};
  const propRegex = /(\w+):((?:"[^"]*")|(?:[^\s]+))/g;
  let match;
  while ((match = propRegex.exec(propsStr)) !== null) {
    const [, key, value] = match;
    props[key] = value.startsWith('"') ? value.slice(1, -1).replace(/\\"/g, '"') : value;
  }
  return props;
}

/** Serialize props back to inline format: id:X status:Y priority:Z */
function serializeInlineProps(props: Record<string, string>): string {
  // Maintain a consistent field order
  const order = ['id', 'status', 'priority', 'owner', 'created', 'updated', 'due', 'tags', 'archived'];
  const parts: string[] = [];

  for (const key of order) {
    if (props[key] !== undefined) {
      const value = props[key];
      // Quote values that contain spaces
      parts.push(value.includes(' ') ? `${key}:"${value}"` : `${key}:${value}`);
    }
  }

  // Append any extra fields not in the standard order
  for (const [key, value] of Object.entries(props)) {
    if (!order.includes(key)) {
      parts.push(value.includes(' ') ? `${key}:"${value}"` : `${key}:${value}`);
    }
  }

  return parts.join(' ');
}
