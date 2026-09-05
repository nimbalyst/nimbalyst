import type { ProjectGraphNode } from "../types";
import type { PrototypeEvent } from "./contracts";

function object(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return object(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function timestamp(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const n =
    typeof value === "number"
      ? value
      : value instanceof Date
      ? value.getTime()
      : typeof value === "string"
      ? Date.parse(value)
      : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
export function eventsForNode(
  node: ProjectGraphNode,
  now: number
): PrototypeEvent[] {
  const fields = node.fields ?? {};
  const events = new Map<string, PrototypeEvent>();
  const add = (
    raw: unknown,
    kind: PrototypeEvent["kind"],
    label: string,
    provenance: PrototypeEvent["provenance"] = "recorded"
  ) => {
    const at = timestamp(raw);
    if (at == null || at > now) return;
    const id = `${node.id}:${kind}:${at}:${label}`;
    events.set(id, { id, nodeId: node.id, at, kind, label, provenance });
  };
  // Only native fields: loader's graph createdAt can be a neighbor-derived date.
  if (
    node.source === "session" ||
    node.source === "tracker" ||
    node.source === "external" ||
    node.source === "memory"
  )
    add(fields.createdAt, "created", "Record created");
  if (node.source === "external") {
    add(fields.closedAt, "status", "Status → closed");
    add(fields.mergedAt, "status", "Status → merged");
  }
  if (node.source === "git") add(fields.isoDate, "commit", "Commit authored");
  if (node.source === "session")
    add(
      fields.lastActivity,
      "last-activity",
      "Last observed session activity",
      "last-observed"
    );
  const data = object(fields.data);
  const activity = Array.isArray(data.activity)
    ? data.activity
    : object(data.system).activity;
  if (Array.isArray(activity)) {
    for (const raw of activity) {
      const a = object(raw);
      if (a.action === "status_changed" && typeof a.newValue === "string")
        add(a.timestamp, "status", `Status → ${a.newValue}`);
    }
  }
  return [...events.values()];
}
