import type { ProjectIndexState } from "../indexing/projectIndex";
import type { PrototypeModel } from "./contracts";
import { SOURCES } from "./viewSettings";

export function indexCoverageMessages(state: ProjectIndexState): string[] {
  return [
    ...(state.fromCache
      ? [
          "Cached lightweight metadata is displayed while sources refresh. Cached records omit detailed event history; these counts are provisional.",
        ]
      : []),
    ...SOURCES.map(({ id, label }) => {
      const c = state.coverage[id];
      if (!c) return `${label}: not indexed yet`;
      const eventText = c.events?.retrieved
        ? `event evidence ${
            c.events.complete ? "complete for indexed scope" : "partial"
          }${
            c.events.window
              ? ` (${new Date(
                  c.events.window.startMs
                ).toLocaleDateString()} – ${new Date(
                  c.events.window.endMs
                ).toLocaleDateString()})`
              : ""
          }${c.events.reason ? ` · ${c.events.reason}` : ""}`
        : "Additional event history not retrieved; native timestamps remain available";
      return `${label}: ${c.indexed.toLocaleString()} indexed${
        c.total == null ? "" : ` of ${c.total.toLocaleString()}`
      } · ${c.detailLoaded} details fetched · ${
        c.availability === "disabled"
          ? "disabled"
          : c.complete
          ? "metadata scope complete"
          : `partial metadata (${c.availability})`
      }${c.truncated ? ` · truncated: ${c.truncationReason}` : ""}${
        c.message ? ` · ${c.message}` : ""
      }${c.scopeDescription ? ` · ${c.scopeDescription}` : ""}${
        c.lastIndexedAt
          ? ` · indexed ${new Date(c.lastIndexedAt).toLocaleString()}`
          : ""
      } · ${eventText}`;
    }),
  ];
}

/** Requested windows and full header enumeration cannot prove complete event history. */
export function periodCoverageForIndex(
  state: ProjectIndexState
): PrototypeModel["periodCoverage"] {
  const enabled = Object.values(state.coverage).filter((c) => c.enabled);
  const complete =
    !state.fromCache &&
    enabled.length > 0 &&
    enabled.every(
      (c) =>
        c.complete &&
        c.availability === "available" &&
        c.events?.retrieved &&
        c.events.complete
    );
  return {
    startMs: complete
      ? Math.max(0, ...enabled.map((c) => c.events?.window?.startMs ?? 0))
      : 0,
    endMs: complete
      ? Math.min(
          state.generatedAt,
          ...enabled.map((c) => c.events?.window?.endMs ?? state.generatedAt)
        )
      : state.generatedAt,
    complete,
    reason: complete
      ? undefined
      : "Available metadata is broader than recorded event history. Comparison counts describe observed evidence; missing history is unknown.",
  };
}
