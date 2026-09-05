import type { ProjectGraphNode, ProjectGraphEdge } from "../types";
import type { SourceCoverage } from "./types";
import type { loadCommitFileEvidence } from "./sources/commitEvidence";

/** Merge against the latest source slice so concurrent lookups retain both answers. */
export function mergeCommitEvidence<
  T extends {
    records: ProjectGraphNode[];
    edges: ProjectGraphEdge[];
    coverage: SourceCoverage;
  }
>(
  slice: T,
  evidence: Awaited<ReturnType<typeof loadCommitFileEvidence>>,
  retrievedWindow: { startMs: number; endMs: number } | null,
  specificCommits: boolean
): T {
  const records = new Map(slice.records.map((r) => [r.id, r]));
  for (const record of evidence.records) records.set(record.id, record);
  let newlyCovered = 0;
  for (const sha of evidence.covered) {
    const record = records.get(`commit:${sha}`);
    if (record && !record.fields?.fileEvidenceLoaded) {
      newlyCovered++;
      records.set(record.id, {
        ...record,
        fields: { ...record.fields, fileEvidenceLoaded: true },
      });
    }
  }
  const edges = new Map(slice.edges.map((e) => [e.id, e]));
  for (const edge of evidence.edges) edges.set(edge.id, edge);

  return {
    ...slice,
    records: Array.from(records.values()),
    edges: Array.from(edges.values()),
    coverage: {
      ...slice.coverage,
      detailLoaded: slice.coverage.detailLoaded + newlyCovered,
      // A failed lookup is recorded on coverage rather than thrown: the
      // header index is still valid and still worth showing.
      message: evidence.error ?? slice.coverage.message,
      eventHistoryComplete: evidence.error
        ? slice.coverage.eventHistoryComplete
        : !retrievedWindow && !specificCommits && !evidence.truncated,
      events: evidence.error
        ? slice.coverage.events
        : {
            support: "window",
            retrieved: true,
            scope: retrievedWindow ? "windowed" : "all-history",
            window: retrievedWindow,
            // Evidence for one window, or for a named set of commits, is not
            // evidence for every indexed commit. Only an unbounded sweep
            // that was not truncated covers the whole metadata scope.
            complete:
              !retrievedWindow && !specificCommits && !evidence.truncated,
            reason: evidence.truncated
              ? "File evidence stopped before the requested scope was exhausted."
              : retrievedWindow
              ? "File evidence was retrieved for the selected window only."
              : specificCommits
              ? "File evidence was retrieved for specific commits only."
              : undefined,
          },
    },
  };
}
