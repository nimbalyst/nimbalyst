import { createHash } from "node:crypto";
import Store from "../../utils/privateSettingsStore";
import type { GitCommitExecutionResult } from "../GitCommitService";

interface ProposalExecution {
  identity: string;
  result?: GitCommitExecutionResult;
}
let store: Store<Record<string, ProposalExecution>> | undefined;
function storage(): Store<Record<string, ProposalExecution>> {
  return (store ??= new Store({ name: "commit-proposal-execution" }));
}
function proposalKey(sessionId: string, promptId: string): string {
  return createHash("sha256")
    .update(JSON.stringify([sessionId, promptId]))
    .digest("hex");
}

/**
 * This process's copy of each execution (identity, then result). It is read
 * before the durable store everywhere -- response validation, dedup and
 * outcome -- so a failed durable write (ENOSPC) cannot make them disagree.
 */
const executions = new Map<string, ProposalExecution>();
/** Executions in progress in this process, so an outcome check can wait for one. */
const running = new Map<string, Promise<GitCommitExecutionResult>>();

/** Tests only: forget this process's copies, as a restart would. */
export function resetCommitProposalExecutionMemoryForTests(): void {
  executions.clear();
}

function lookupExecution(key: string): ProposalExecution | undefined {
  return executions.get(key) ?? storage().get(key);
}

/** A losing card/voice attempt must not terminalize the winning in-flight commit. */
export function acceptsCommitProposalResponse(
  sessionId: string,
  promptId: string,
  response: { action?: string; commitHash?: string; error?: string }
): boolean {
  const execution = lookupExecution(proposalKey(sessionId, promptId));
  if (!execution) return true; // Compatibility for pre-reservation desktop clients.
  if (!execution.result) return false;
  if (execution.identity === "cancelled")
    return response.action === "cancelled";
  return execution.result.success
    ? response.action === "committed" &&
        response.commitHash === execution.result.commitHash
    : response.action === "error" &&
        response.error ===
          (execution.result.error || "No changes were committed");
}

export function commitProposalIdentity(
  workspace: string,
  message: string,
  files: string[],
  hunks?: unknown,
  repoPath?: string
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        workspace,
        message,
        files,
        hunks ?? null,
        repoPath ?? null,
      ])
    )
    .digest("hex");
}

/** Shared by the desktop widget, desktop voice and mobile card/voice. */
export async function runCommitProposalOnce(
  sessionId: string,
  promptId: string,
  identity: string,
  execute: () => Promise<GitCommitExecutionResult>
): Promise<GitCommitExecutionResult> {
  const key = proposalKey(sessionId, promptId);
  const old = lookupExecution(key);
  if (old) {
    if (old.identity !== identity)
      return {
        success: false,
        error:
          "This proposal was already handled with another selection or cancelled. Create a fresh proposal.",
      };
    return (
      old.result ?? {
        success: false,
        error:
          "This proposal is already executing or its outcome is unknown. Inspect Git history; do not replay it.",
      }
    );
  }
  storage().set(key, { identity });
  executions.set(key, { identity });
  const run = (async (): Promise<GitCommitExecutionResult> => {
    let result: GitCommitExecutionResult;
    try {
      result = await execute();
    } catch (error) {
      result = {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Commit outcome is unknown; inspect Git history.",
      };
    }
    // A failed write (ENOSPC) must not lose what git did: the caller still
    // settles with this result, and this process still validates and reports it.
    executions.set(key, { identity, result });
    try {
      storage().set(key, { identity, result });
    } catch (error) {
      console.error("[CommitProposalExecution] Failed to record commit proposal result:", error);
    }
    return result;
  })();
  running.set(key, run);
  try {
    return await run;
  } finally {
    running.delete(key);
  }
}

export type CommitProposalOutcome =
  | { kind: "committed"; commitHash: string; commitDate?: string }
  | { kind: "not-committed" };

/**
 * #1682: what THIS proposal's own execution did. A commit with the same
 * message or files made by anything else is never reported. An execution of
 * this proposal still in progress (an earlier, abandoned call) is waited for.
 */
export async function commitProposalOutcome(
  sessionId: string,
  promptId: string
): Promise<CommitProposalOutcome> {
  const key = proposalKey(sessionId, promptId);
  const result = (await running.get(key)) ?? lookupExecution(key)?.result;
  return result?.success && result.commitHash
    ? { kind: "committed", commitHash: result.commitHash, commitDate: result.commitDate }
    : { kind: "not-committed" };
}

export async function cancelCommitProposalOnce(
  sessionId: string,
  promptId: string
): Promise<boolean> {
  return (
    await runCommitProposalOnce(sessionId, promptId, "cancelled", async () => ({
      success: true,
    }))
  ).success;
}
