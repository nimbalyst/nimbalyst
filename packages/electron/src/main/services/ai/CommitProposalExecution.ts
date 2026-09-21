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

/** A losing card/voice attempt must not terminalize the winning in-flight commit. */
export function acceptsCommitProposalResponse(
  sessionId: string,
  promptId: string,
  response: { action?: string; commitHash?: string; error?: string }
): boolean {
  const execution = storage().get(proposalKey(sessionId, promptId));
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
  const old = storage().get(key);
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
  storage().set(key, { identity, result });
  return result;
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
