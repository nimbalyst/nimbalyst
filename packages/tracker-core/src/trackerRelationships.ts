import type { TrackerFieldDefinition } from "./context.js";

export interface TrackerRelationshipValue {
  itemId: string;
  issueKey?: string;
  title?: string;
  trackerType?: string;
  relationshipTypeKey?: string;
  direction?: "out";
  metadata?: Record<string, unknown>;
  /**
   * Pins the reference to one exact revision of the target (knowledge-scopes
   * contract 4.2). A UUID; absent means the live item. Mirrored from the richer
   * declaration in `@nimbalyst/tracker-schema`, which cannot be imported here.
   */
  revisionId?: string;
  /** Room-assigned display number for `revisionId`. Advisory; never resolves. */
  serverRevision?: number;
}

export function isRelationshipField(
  def: Pick<TrackerFieldDefinition, "type">
): boolean {
  return def.type === "relationship" || def.type === "reference";
}

export function normalizeRelationshipValue(
  raw: unknown
): TrackerRelationshipValue[] {
  const list: unknown[] = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  const byId = new Map<string, TrackerRelationshipValue>();
  for (const entry of list) {
    const value = coerceRelationship(entry);
    if (value) byId.set(value.itemId, value);
  }
  return [...byId.values()];
}

/**
 * Coerce one stored entry.
 *
 * This is an explicit ALLOW-LIST, not a spread, so a key it does not name is
 * dropped -- including on the way back out, because `addRelationshipValue`
 * normalizes the existing entries before appending. Anything added to
 * {@link TrackerRelationshipValue} has to be named here or adding a second
 * target to a field silently strips it from the first.
 */
function coerceRelationship(entry: unknown): TrackerRelationshipValue | null {
  if (typeof entry === "string") return entry ? { itemId: entry } : null;
  if (!entry || typeof entry !== "object") return null;
  const object = entry as Record<string, unknown>;
  const itemId =
    typeof object.itemId === "string"
      ? object.itemId
      : typeof object.id === "string"
      ? object.id
      : "";
  if (!itemId) return null;
  const value: TrackerRelationshipValue = { itemId };
  if (typeof object.issueKey === "string") value.issueKey = object.issueKey;
  if (typeof object.title === "string") value.title = object.title;
  if (typeof object.trackerType === "string")
    value.trackerType = object.trackerType;
  if (typeof object.relationshipTypeKey === "string")
    value.relationshipTypeKey = object.relationshipTypeKey;
  if (object.direction === "out") value.direction = "out";
  if (object.metadata && typeof object.metadata === "object")
    value.metadata = object.metadata as Record<string, unknown>;
  if (typeof object.revisionId === "string") value.revisionId = object.revisionId;
  if (typeof object.serverRevision === "number")
    value.serverRevision = object.serverRevision;
  return value;
}
