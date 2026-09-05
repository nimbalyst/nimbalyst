import type { ProjectGraphNode, ProjectGraphSnapshot } from "../types";
export interface AreaRule {
  id: string;
  label: string;
  slot: number;
  tags?: string[];
  anchorIds?: string[];
  paths?: string[];
  hidden?: boolean;
}

const NON_TOPIC_TAGS = new Set([
  "bug",
  "bug-fix",
  "feature",
  "refactor",
  "design",
  "planning",
  "implementing",
  "validating",
  "complete",
  "completed",
  "uncommitted",
  "archived-candidate",
  "archived",
  "in-progress",
  "in-review",
  "backlog",
  "committed",
  "review",
  "research",
  "investigation",
  "prototype",
  "triage",
  "needs-verification",
  "github-pr",
  "github-issue",
  "build-fix",
  "test",
  "tests",
  "testing",
  "ui",
  "ux",
  "frontend",
  "backend",
  "electron",
  "runtime",
  "extension",
  "extensions",
  "documentation",
  "docs",
  "chore",
  "task",
  "high",
  "medium",
  "low",
]);
const INITIAL_AREAS = 12;
// Display-only aliases observed in project tags. Source records remain intact.
const TOPIC_ALIASES = new Map([
  ["collab", "collaboration"],
  ["trackers", "tracker"],
]);
export function normalizedTags(node: ProjectGraphNode): string[] {
  return [
    ...new Set(
      (node.tags ?? [])
        .map((t) => t.trim().toLowerCase().replace(/\s+/g, "-"))
        .map((t) => TOPIC_ALIASES.get(t) ?? t)
        .filter(Boolean)
    ),
  ];
}
/** Workflow labels are excluded only from automatic seeding, never explicit rules. */
export function topicTags(node: ProjectGraphNode): string[] {
  return normalizedTags(node).filter(
    (t) =>
      !NON_TOPIC_TAGS.has(t) &&
      !/^tag\d+$/.test(t) &&
      !/(?:^|-)20\d{2}(?:-|$)/.test(t)
  );
}

const strings = (v: unknown): string[] =>
  Array.isArray(v)
    ? [
        ...new Set(
          v
            .filter((s): s is string => typeof s === "string" && s.length > 0)
            .map((s) => s.trim())
        ),
      ]
    : [];

/** Validate persisted user rules without renumbering valid slots. */
export function normalizeAreaRegistry(value: unknown): AreaRule[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  const slots = new Set<number>();
  const result: AreaRule[] = [];
  for (const entry of value.slice(0, 200)) {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof entry.id !== "string" ||
      !entry.id ||
      ids.has(entry.id)
    )
      continue;
    let slot =
      Number.isSafeInteger(entry.slot) && entry.slot >= 0 && entry.slot < 500
        ? entry.slot
        : 0;
    while (slots.has(slot)) slot++;
    ids.add(entry.id);
    slots.add(slot);
    result.push({
      id: entry.id,
      label:
        typeof entry.label === "string" && entry.label.trim()
          ? entry.label.trim().slice(0, 80)
          : entry.id,
      slot,
      tags: strings(entry.tags),
      anchorIds: strings(entry.anchorIds),
      paths: strings(entry.paths).map((p) => p.replace(/\/+$/, "")),
      hidden: entry.hidden === true,
    });
  }
  return result;
}

/** Seeding happens once; source refresh never replaces the chosen rules. */
export function createAreaRegistry(snapshot: ProjectGraphSnapshot): AreaRule[] {
  const counts = new Map<string, number>();
  for (const node of snapshot.nodes)
    for (const tag of topicTags(node))
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
  const tags = [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, INITIAL_AREAS)
    .map(([tag]) => tag)
    .sort();
  return [
    ...tags.map((tag, slot) => ({
      id: `tag:${tag}`,
      label: tag.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase()),
      slot,
      tags: [tag],
    })),
    { id: "unassigned", label: "Unassigned", slot: tags.length },
  ];
}

export function addAreaRule(
  registry: AreaRule[],
  rule: Omit<AreaRule, "slot">
): AreaRule[] {
  if (registry.some((r) => r.id === rule.id)) return registry;
  return [
    ...registry,
    { ...rule, slot: Math.max(-1, ...registry.map((r) => r.slot)) + 1 },
  ];
}

export function ruleMatches(
  rule: AreaRule,
  node: ProjectGraphNode,
  preparedTags?: string[]
): string | undefined {
  if (rule.anchorIds?.includes(node.id)) return "Selected anchor record";
  const tag = (preparedTags ?? normalizedTags(node)).find((t) =>
    rule.tags?.some(
      (tag) =>
        (TOPIC_ALIASES.get(tag.trim().toLowerCase().replace(/\s+/g, "-")) ??
          tag.trim().toLowerCase().replace(/\s+/g, "-")) === t
    )
  );
  if (tag) return `Tag: ${tag}`;
  const path = node.fields?.path ?? node.fields?.documentPath;
  if (typeof path === "string") {
    const prefix = rule.paths?.find(
      (p) => path === p || path.startsWith(`${p}/`)
    );
    if (prefix) return `Path rule: ${prefix}`;
  }
  return undefined;
}
