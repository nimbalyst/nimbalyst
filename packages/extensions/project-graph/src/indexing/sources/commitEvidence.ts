import type { PanelHost } from "@nimbalyst/extension-sdk";
import type { ProjectGraphEdge, ProjectGraphNode } from "../../types";
import type { CancelSignal } from "../types";
import { dirNodeId, moduleForPath } from "../../adapters/paths";
import { directoryNode } from "../../adapters/databaseAdapter";
import { provenanceFor } from "../../adapters/recordMapping";
import { shellQuote } from "../../adapters/fileEnumeration";

const COMMIT_MARKER = "__COMMIT__";
const PAGE_SIZE = 250;

/**
 * Fetch which directories a bounded set of commits touched.
 *
 * Separate from the header pass on purpose: this is the expensive query, and
 * the caller decides how much of it to pay for. The returned `covered` set says
 * exactly which commits the evidence is for, so a consumer can distinguish "no
 * directories" from "not looked up yet".
 */
export async function loadCommitFileEvidence(
  host: PanelHost,
  signal: CancelSignal,
  request: {
    shas?: readonly string[];
    sinceMs?: number | null;
    untilMs?: number | null;
    maxCommits?: number;
  }
): Promise<{
  records: ProjectGraphNode[];
  edges: ProjectGraphEdge[];
  covered: string[];
  truncated: boolean;
  error?: string;
}> {
  const max =
    request.maxCommits == null
      ? Infinity
      : Math.max(0, Math.floor(request.maxCommits));
  const shas = request.shas?.length ? [...new Set(request.shas)] : null;
  const parts = [
    "git log --no-merges --name-only",
    `--pretty=format:${shellQuote(`${COMMIT_MARKER}%H`)}`,
  ];
  if (!shas) {
    parts.push("--all");
    if (request.sinceMs != null)
      parts.push(
        `--since=${shellQuote(new Date(request.sinceMs).toISOString())}`
      );
    if (request.untilMs != null)
      parts.push(
        `--until=${shellQuote(new Date(request.untilMs).toISOString())}`
      );
  }

  const dirTotals = new Map<string, number>();
  const edges: ProjectGraphEdge[] = [];
  const seenEdges = new Set<string>();
  const covered: string[] = [];

  let truncated = false;
  for (let skip = 0; ; ) {
    signal.throwIfCancelled();
    // One lookahead record distinguishes an exact maximum from truncation.
    const size = Math.min(PAGE_SIZE, max - covered.length + 1);
    const selected = shas?.slice(skip, skip + size);
    if (selected && !selected.length) break;
    const page = selected
      ? ["--no-walk", ...selected.map(shellQuote)]
      : [`--skip=${skip}`, `-n ${size}`];
    const res = await host.exec([...parts, ...page].join(" "), {
      timeout: 60000,
      maxBuffer: 16 * 1024 * 1024,
    });
    signal.throwIfCancelled();
    if (!res.success)
      return {
        records: Array.from(dirTotals, ([dir, count]) =>
          directoryNode(dir, "touches", count)
        ),
        edges,
        covered,
        truncated: true,
        error: (res.stderr || `git log exited ${res.exitCode}`).slice(0, 200),
      };
    const blocks = res.stdout
      .split(COMMIT_MARKER)
      .filter((block) => block.trim());
    for (const block of blocks) {
      if (covered.length >= max) {
        truncated = true;
        break;
      }
      const lines = block.split("\n");
      const sha = (lines[0] ?? "").trim();
      if (!sha) continue;
      covered.push(sha);
      const commitId = `commit:${sha}`;
      for (const raw of lines.slice(1)) {
        const file = raw.trim();
        if (!file) continue;
        const dir = moduleForPath(file, host.workspacePath);
        if (!dir) continue;
        dirTotals.set(dir, (dirTotals.get(dir) ?? 0) + 1);
        const dirId = dirNodeId(dir);
        const edgeId = `${commitId}->${dirId}`;
        if (seenEdges.has(edgeId)) continue;
        seenEdges.add(edgeId);
        edges.push({
          id: edgeId,
          type: "touches",
          sourceId: commitId,
          targetId: dirId,
          provenance: provenanceFor("touches"),
        });
      }
    }

    if (
      truncated ||
      (selected ? skip + selected.length >= shas!.length : blocks.length < size)
    )
      break;
    skip += selected?.length ?? blocks.length;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  const records = Array.from(dirTotals, ([dir, count]) =>
    directoryNode(dir, "touches", count)
  );
  return { records, edges, covered, truncated };
}
