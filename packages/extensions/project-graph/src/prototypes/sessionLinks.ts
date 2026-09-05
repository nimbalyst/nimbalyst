import type { ProjectGraphSnapshot } from "../types";

/** Restore session-side recorded links including references outside the loaded snapshot. */
export function withRecordedSessionLinks(
  snapshot: ProjectGraphSnapshot
): ProjectGraphSnapshot {
  const trackers = new Map(
    snapshot.nodes
      .filter((n) => n.source === "tracker")
      .map((n) => [n.fields?.id, n.id])
  );
  const existing = new Set(
    snapshot.edges
      .filter((e) => e.type === "worked_on_in")
      .map((e) => `${e.sourceId}\u0000${e.targetId}`)
  );
  const added: ProjectGraphSnapshot["edges"] = [];
  for (const session of snapshot.nodes) {
    if (
      session.source !== "session" ||
      !Array.isArray(session.fields?.linkedTrackerItemIds)
    )
      continue;
    for (const id of session.fields.linkedTrackerItemIds) {
      if (typeof id !== "string") continue;
      const file = id.startsWith("file:")
        ? snapshot.nodes.find(
            (n) =>
              n.source === "file" &&
              (n.fields?.path === id.slice(5) ||
                n.fields?.documentPath === id.slice(5))
          )
        : undefined;
      const sourceId = id.startsWith("file:")
        ? file?.id ?? id
        : trackers.get(id) ??
          (id.startsWith("tracker:") ? id : `tracker:${id}`);
      const key = `${sourceId}\u0000${session.id}`;
      if (existing.has(key)) continue;
      existing.add(key);
      added.push({
        id: `prototype-session-link:${sourceId}->${session.id}`,
        sourceId,
        targetId: session.id,
        type: "worked_on_in",
        label: "Recorded session source link",
        provenance: {
          kind: "recorded",
          basis:
            "Reference recorded in session linkedTrackerItemIds metadata; the target may be outside the loaded snapshot.",
        },
      });
    }
  }
  return added.length
    ? {
        ...snapshot,
        edges: [...snapshot.edges, ...added],
        stats: {
          ...snapshot.stats,
          edgeCount: snapshot.edges.length + added.length,
        },
      }
    : snapshot;
}
