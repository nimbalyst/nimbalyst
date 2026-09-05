import type { PanelHost } from '@nimbalyst/extension-sdk';
import { relationshipFieldsOf, type TrackerFieldDefinition } from './trackerRelationships';

/**
 * Tracker types are fully user-defined: a workspace can declare any number of
 * tracker types (blog, video, idea, epic, ...) via `tracker_define_type`, each
 * with its own display name, color, icon, and status options. The project graph
 * must therefore DISCOVER the types present in the workspace rather than rely on
 * a hardcoded list -- otherwise custom types render with no sidebar toggle and
 * no proper color/label.
 *
 * This module reads the `tracker_type_defs` table (the authoritative registry
 * written by the tracker system) and returns a normalized descriptor per type.
 * The config layer turns these into `GraphNodeTypeSchema` entries.
 */

export interface DiscoveredTrackerType {
  /** Canonical tracker type id, e.g. "blog". */
  type: string;
  /** Human label (tracker `displayName`), e.g. "Blog". */
  label: string;
  /** Hex/CSS color from the type def, if the user set one. */
  color?: string;
  /** Material icon name from the type def, if any. */
  icon?: string;
  /**
   * This type's field definitions. The only reliable way to tell a relationship
   * field from a same-named scalar one: `bug.area` is a relationship to
   * feature-module/product-feature while `github-issue.area` is a plain select.
   */
  fields: TrackerFieldDefinition[];
}

interface TrackerTypeDefRow {
  type: string;
  // JSON model column: parsed object on PGLite, JSON string on better-sqlite3.
  model: Record<string, unknown> | string | null;
  deleted_at: string | Date | null;
}

function parseModel(raw: Record<string, unknown> | string | null): Record<string, unknown> {
  if (raw == null) return {};
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return typeof raw === 'object' ? raw : {};
}

/**
 * Load all (non-deleted) tracker type definitions for the workspace. Returns an
 * empty list if the table is missing or the query API is unavailable -- the
 * graph still works off its built-in schemas in that case.
 */
export async function discoverTrackerTypes(host: PanelHost): Promise<DiscoveredTrackerType[]> {
  if (!host.data?.query) return [];
  let rows: TrackerTypeDefRow[];
  try {
    rows = await host.data.query<TrackerTypeDefRow>(
      `SELECT type, model, deleted_at
         FROM tracker_type_defs
        WHERE workspace = $1
          AND deleted_at IS NULL`,
      [host.workspacePath],
    );
  } catch {
    // Table may not exist on older installs; fail soft.
    return [];
  }

  const out: DiscoveredTrackerType[] = [];
  for (const row of rows) {
    if (!row.type) continue;
    const model = parseModel(row.model);
    const label =
      typeof model.displayName === 'string' && model.displayName.trim()
        ? model.displayName.trim()
        : row.type;
    const color = typeof model.color === 'string' && model.color.trim() ? model.color.trim() : undefined;
    const icon = typeof model.icon === 'string' && model.icon.trim() ? model.icon.trim() : undefined;
    out.push({ type: row.type, label, color, icon, fields: parseFields(model.fields) });
  }
  return out;
}

/**
 * Relationship field definitions per tracker type.
 *
 * A type missing from the map means its schema could not be read, and callers
 * must emit no relationships for it rather than guessing from field names.
 */
export async function loadRelationshipFieldIndex(
  host: PanelHost,
): Promise<Map<string, TrackerFieldDefinition[]>> {
  const types = await discoverTrackerTypes(host);
  const index = new Map<string, TrackerFieldDefinition[]>();
  for (const t of types) index.set(t.type, relationshipFieldsOf(t.fields));
  return index;
}

function parseFields(raw: unknown): TrackerFieldDefinition[] {
  if (!Array.isArray(raw)) return [];
  const out: TrackerFieldDefinition[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const f = entry as Record<string, unknown>;
    if (typeof f.name !== 'string' || typeof f.type !== 'string') continue;
    out.push({
      name: f.name,
      type: f.type,
      relationshipTypeKey: typeof f.relationshipTypeKey === 'string' ? f.relationshipTypeKey : undefined,
      inverseRelationshipTypeKey:
        typeof f.inverseRelationshipTypeKey === 'string' ? f.inverseRelationshipTypeKey : undefined,
      targetTrackerTypes:
        f.targetTrackerTypes === '*'
          ? '*'
          : Array.isArray(f.targetTrackerTypes)
            ? f.targetTrackerTypes.filter((t): t is string => typeof t === 'string')
            : undefined,
      multiValue: typeof f.multiValue === 'boolean' ? f.multiValue : undefined,
    });
  }
  return out;
}
