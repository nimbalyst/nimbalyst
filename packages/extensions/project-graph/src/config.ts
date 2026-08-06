import type { PanelHost } from '@nimbalyst/extension-sdk';
import type {
  GraphNodeTypeSchema,
  GraphViewDefinition,
  NodeCategory,
} from './types';
import { BUILTIN_NODE_TYPES, BUILTIN_VIEWS, TRACKER_CATEGORY } from './schema';
import { discoverTrackerTypes } from './adapters/trackerTypeDefs';

/** Neutral color for a discovered tracker type whose def carries no color. */
const TRACKER_FALLBACK_COLOR = '#6b7280';

/**
 * Per-workspace config for the project-graph extension.
 *
 * Lives at `.nimbalyst/project-graph.json` relative to the workspace root.
 * Everything is optional; anything omitted falls back to the built-in defaults.
 *
 * Example:
 *
 * ```json
 * {
 *   "categories": [
 *     { "id": "compliance", "label": "Compliance" }
 *   ],
 *   "types": [
 *     {
 *       "type": "risk",
 *       "label": "Risk",
 *       "category": "compliance",
 *       "color": "#5ad4d4",
 *       "shape": "dot",
 *       "quickActions": ["open", "reveal-in-tracker"]
 *     },
 *     {
 *       "type": "module",
 *       "color": "#88e3ff"
 *     }
 *   ],
 *   "views": [
 *     {
 *       "id": "compliance-overview",
 *       "name": "Compliance",
 *       "includedTypes": ["risk", "decision", "incident", "module"]
 *     }
 *   ]
 * }
 * ```
 */
export interface ProjectGraphConfigFile {
  categories?: ConfigCategory[];
  /** Add new types, or override fields on built-in types (matched by `type`). */
  types?: ConfigTypeEntry[];
  /** Saved views appended to the built-ins. Use the same id to override one. */
  views?: GraphViewDefinition[];
}

export interface ConfigCategory {
  id: string;
  label: string;
}

export interface ConfigTypeEntry {
  type: string;
  label?: string;
  category?: string;
  /** Hex string or CSS color. Stored on the type schema as a colorToken
   *  CSS custom property at runtime. */
  color?: string;
  shape?: GraphNodeTypeSchema['shape'];
  childTypes?: string[];
  quickActions?: GraphNodeTypeSchema['quickActions'];
}

export interface ResolvedProjectGraphConfig {
  /** All node type schemas in priority order: overridden built-ins + new types. */
  types: GraphNodeTypeSchema[];
  /** Built-in views + project views (project views with matching id override). */
  views: GraphViewDefinition[];
  /** Extra categories beyond the built-in set, surfaced in the sidebar. */
  extraCategories: ConfigCategory[];
  /** Inline CSS color tokens to inject onto the panel root for new types. */
  colorOverrides: Record<string, string>;
  /** Whether a project config file was found. */
  hasProjectConfig: boolean;
  /** Path that was checked (for diagnostics). */
  configPath: string;
}

const CONFIG_RELATIVE_PATH = '.nimbalyst/project-graph.json';

/**
 * Build a CSS custom-property name for a given type. Used to inject project
 * colors via inline style on the panel root.
 */
function colorTokenForType(type: string): string {
  return `--pg-c-custom-${type.replace(/[^a-z0-9-]/gi, '-').toLowerCase()}`;
}

function isKnownCategory(id: string): id is NodeCategory {
  return [
    'strategy',
    'delivery',
    'knowledge',
    'people',
    'external',
    'system',
  ].includes(id);
}

/**
 * Load and merge `.nimbalyst/project-graph.json` from the workspace.
 *
 * Built-ins are always present; the project config layers on top (overrides win
 * field-by-field). Unknown JSON shape => fall back to defaults silently rather
 * than break the panel.
 */
export async function loadProjectGraphConfig(
  host: PanelHost,
): Promise<ResolvedProjectGraphConfig> {
  const colorOverrides: Record<string, string> = {};

  // 1. Seed with the built-in schemas, then overlay the workspace's tracker
  //    type definitions (the authoritative, user-configurable registry). This
  //    is what lets custom tracker types (blog, video, idea, ...) appear with a
  //    real label/color/toggle instead of falling through as unknown.
  const merged = new Map<string, GraphNodeTypeSchema>();
  for (const b of BUILTIN_NODE_TYPES) merged.set(b.type, b);

  const discovered = await discoverTrackerTypes(host).catch(() => []);
  for (const d of discovered) {
    const token = colorTokenForType(d.type);
    // Always inject a resolvable color so the swatch never renders empty.
    colorOverrides[token] = d.color ?? TRACKER_FALLBACK_COLOR;
    const existing = merged.get(d.type);
    if (existing) {
      // Known type: take the tracker's display name + color so the graph stays
      // consistent with the tracker UI, but keep the curated category/shape.
      merged.set(d.type, {
        ...existing,
        label: d.label || existing.label,
        colorToken: d.color ? token : existing.colorToken,
      });
    } else {
      // Brand-new tracker type: home it in the catch-all "Trackers" group.
      merged.set(d.type, {
        type: d.type,
        label: d.label,
        category: TRACKER_CATEGORY,
        colorToken: token,
        shape: 'pill',
        quickActions: ['open', 'reveal-in-tracker'],
      });
    }
  }

  // 2. Load the optional project-graph.json (highest-priority overrides).
  const fallback: ResolvedProjectGraphConfig = {
    types: Array.from(merged.values()),
    views: BUILTIN_VIEWS,
    extraCategories: [],
    colorOverrides,
    hasProjectConfig: false,
    configPath: CONFIG_RELATIVE_PATH,
  };

  let raw: string;
  try {
    const result = await host.exec(
      `[ -f ${CONFIG_RELATIVE_PATH} ] && cat ${CONFIG_RELATIVE_PATH} || true`,
      { timeout: 5000 },
    );
    if (!result.success || !result.stdout.trim()) return fallback;
    raw = result.stdout;
  } catch {
    return fallback;
  }

  let parsed: ProjectGraphConfigFile;
  try {
    parsed = JSON.parse(raw) as ProjectGraphConfigFile;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[project-graph] failed to parse project-graph.json', err);
    return fallback;
  }

  const extraCategories: ConfigCategory[] = [];
  for (const cat of parsed.categories ?? []) {
    if (!cat?.id || !cat?.label) continue;
    if (isKnownCategory(cat.id)) continue; // built-in already known
    extraCategories.push({ id: cat.id, label: cat.label });
  }

  // Apply project type overrides on top of the built-in + discovered set.
  for (const entry of parsed.types ?? []) {
    if (!entry?.type) continue;
    const existing = merged.get(entry.type);
    if (existing) {
      const merge: GraphNodeTypeSchema = {
        ...existing,
        label: entry.label ?? existing.label,
        shape: entry.shape ?? existing.shape,
        childTypes: entry.childTypes ?? existing.childTypes,
        quickActions: entry.quickActions ?? existing.quickActions,
      };
      if (entry.category) {
        merge.category = (isKnownCategory(entry.category)
          ? entry.category
          : (entry.category as NodeCategory));
      }
      if (entry.color) {
        const token = colorTokenForType(entry.type);
        colorOverrides[token] = entry.color;
        merge.colorToken = token;
      }
      merged.set(entry.type, merge);
      continue;
    }
    // Brand-new type declared only in project-graph.json.
    if (!entry.label || !entry.category) {
      // eslint-disable-next-line no-console
      console.warn(
        `[project-graph] custom type "${entry.type}" missing required label/category; skipping`,
      );
      continue;
    }
    const token = colorTokenForType(entry.type);
    if (entry.color) colorOverrides[token] = entry.color;
    merged.set(entry.type, {
      type: entry.type,
      label: entry.label,
      category: (isKnownCategory(entry.category)
        ? entry.category
        : (entry.category as NodeCategory)),
      colorToken: token,
      shape: entry.shape ?? 'pill',
      childTypes: entry.childTypes,
      quickActions: entry.quickActions,
    });
  }

  // Views: project views with the same id override built-ins.
  const viewsById = new Map<string, GraphViewDefinition>();
  for (const v of BUILTIN_VIEWS) viewsById.set(v.id, v);
  for (const v of parsed.views ?? []) {
    if (!v?.id || !v?.name) continue;
    viewsById.set(v.id, { ...v, builtin: false });
  }

  return {
    types: Array.from(merged.values()),
    views: Array.from(viewsById.values()),
    extraCategories,
    colorOverrides,
    hasProjectConfig: true,
    configPath: CONFIG_RELATIVE_PATH,
  };
}
