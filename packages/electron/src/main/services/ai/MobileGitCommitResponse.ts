import { BrowserWindow, ipcMain } from "electron";
import { AISessionsRepository } from "@nimbalyst/runtime/storage/repositories/AISessionsRepository";
import { AgentMessagesRepository } from "@nimbalyst/runtime/storage/repositories/AgentMessagesRepository";
import { logger } from "../../utils/logger";
import { TrayManager } from "../../tray/TrayManager";
import {
  getGitCommitProposalResponseChannel,
  resolveGitCommitProposalPromptId,
} from "./gitCommitProposalPromptUtils";
import { getGitSubprocessEnv } from "../gitEnv";
import { SessionCommitService } from "../SessionCommitService";
import { getDatabase } from "../../database/initialize";
import { createWorktreeStore } from "../WorktreeStore";
import { resolve as resolvePath } from "path";
import {
  createGitCommitProposalResponse,
  executeGitCommitAcrossRepos,
  type GitCommitProposalResponse,
} from "../GitCommitService";
import { resolveExtraCommitRoots } from "../workspaceRepos";
import {
  runCommitProposalOnce,
  commitProposalIdentity,
  cancelCommitProposalOnce,
  acceptsCommitProposalResponse,
} from "./CommitProposalExecution";

const log = logger.ai;
interface GitCommitResponse {
  action: "committed" | "cancelled";
  files?: string[];
  message?: string;
}
function notifyAllWindows(
  channel: string,
  data: Record<string, unknown>
): void {
  for (const win of BrowserWindow.getAllWindows().filter(
    (w) => !w.isDestroyed()
  ))
    win.webContents.send(channel, data);
}

/**
 * Worktree sessions retain the parent project as `workspacePath` for session
 * listing and permissions. Commit execution must use the session's actual
 * worktree path, and fail closed if that native binding is incomplete.
 */
export function resolveGitCommitWorkspacePath(session: {
  workspacePath?: string | null;
  worktreeId?: string | null;
  worktreePath?: string | null;
}): string | null {
  if (session.worktreeId || session.worktreePath) {
    return session.worktreeId && session.worktreePath
      ? session.worktreePath
      : null;
  }
  return session.workspacePath || null;
}

/**
 * Handle GitCommit response from mobile
 * Mobile can approve the commit, but desktop must execute it
 */
export async function handleGitCommitResponse(
  sessionId: string,
  promptId: string,
  response: GitCommitResponse,
  findWindowByWorkspace: (
    workspacePath: string
  ) => BrowserWindow | null | undefined
): Promise<GitCommitProposalResponse> {
  log.info(
    "Handling GitCommit response:",
    promptId,
    "action:",
    response.action
  );
  let canonicalPromptId: string;
  try {
    canonicalPromptId = await resolveGitCommitProposalPromptId(
      sessionId,
      promptId,
      false
    );
  } catch {
    return {
      action: "error",
      error:
        "Cannot identify this exact commit proposal. Refresh the session before answering.",
    };
  }

  // Helper to emit the proposal response to unblock the MCP tool
  const emitProposalResponse = async (
    result: GitCommitProposalResponse
  ): Promise<GitCommitProposalResponse> => {
    if (!acceptsCommitProposalResponse(sessionId, canonicalPromptId, result))
      return {
        action: "error",
        error:
          "This proposal has another pending or completed outcome. Inspect its existing result.",
      };
    const responseChannel = getGitCommitProposalResponseChannel(
      sessionId,
      canonicalPromptId
    );
    await AgentMessagesRepository.create({
      sessionId,
      source: "nimbalyst",
      direction: "output" as const,
      createdAt: new Date(),
      content: JSON.stringify({
        type: "git_commit_proposal_response",
        proposalId: canonicalPromptId,
        action: result.action,
        commitHash: result.commitHash,
        commitDate: result.commitDate,
        error: result.error,
        filesCommitted: result.filesCommitted,
        commitMessage: result.commitMessage,
        respondedBy: "mobile",
        respondedAt: Date.now(),
      }),
    });
    ipcMain.emit(responseChannel, null, result);

    // Record the sha -> session link for the Git Log panel (idempotent; the
    // MCP settle path records the same row when the tool is still waiting)
    if (result.action === "committed" && result.commitHash) {
      void SessionCommitService.getInstance().recordCommit({
        commitSha: result.commitHash,
        sessionId,
      });
    }

    // Notify renderer to clear the pending interactive prompt indicator
    notifyAllWindows("ai:gitCommitProposalResolved", {
      sessionId,
      proposalId: canonicalPromptId,
    });
    TrayManager.getInstance().onPromptResolved(sessionId);
    return result;
  };

  if (response.action === "cancelled") {
    if (!(await cancelCommitProposalOnce(sessionId, canonicalPromptId)))
      return { action: "error", error: "This proposal was already handled." };
    return await emitProposalResponse({ action: "cancelled" });
  }

  // For 'committed' action, we need to execute the git commit on desktop
  if (!response.files || !response.message) {
    log.error("GitCommit response missing files or message");
    return await emitProposalResponse({
      action: "error",
      error: "Missing files or message",
    });
  }

  // Look up the session's workspace path
  try {
    const session = await AISessionsRepository.get(sessionId);
    if (!session) {
      log.error("GitCommit: session not found:", sessionId);
      return await emitProposalResponse({
        action: "error",
        error: "Session not found",
      });
    }

    const workspacePath = resolveGitCommitWorkspacePath(session);
    if (!workspacePath) {
      const error = session.worktreeId
        ? "Worktree session has no valid worktree path; refusing to commit"
        : "No workspace path";
      log.error("GitCommit:", error, sessionId);
      return await emitProposalResponse({ action: "error", error });
    }

    // A worktree ID is the native authority record. Do not trust a stale or
    // agent-influenced session path when that record no longer matches it.
    if (session.worktreeId) {
      const db = getDatabase();
      const nativeWorktree = db
        ? await createWorktreeStore(db).get(session.worktreeId)
        : null;
      const recordedPath = session.worktreePath;
      if (
        !nativeWorktree ||
        !recordedPath ||
        resolvePath(nativeWorktree.path) !== resolvePath(recordedPath)
      ) {
        log.error(
          "GitCommit: native worktree binding mismatch for session:",
          sessionId
        );
        return await emitProposalResponse({
          action: "error",
          error:
            "Worktree binding changed or is unavailable; refusing to commit",
        });
      }
    }

    // Across-repos, not `executeGitCommit`: the single-repo path makes any file
    // outside `workspacePath` throw 'File is outside the repository', which
    // failed the WHOLE commit -- including the files that were committable.
    const commitResult = await runCommitProposalOnce(
      sessionId,
      canonicalPromptId,
      commitProposalIdentity(workspacePath, response.message, response.files),
      () =>
        executeGitCommitAcrossRepos(
          workspacePath,
          response.message!,
          response.files!,
          {
            logContext: "[GitCommit mobile]",
            env: getGitSubprocessEnv(),
            extraRoots: resolveExtraCommitRoots(
              workspacePath,
              session.workspacePath
            ),
          }
        )
    );
    return await emitProposalResponse(
      createGitCommitProposalResponse(
        commitResult,
        response.files,
        response.message
      )
    );
  } catch (error) {
    log.error("[GitCommit mobile] Failed to execute commit:", error);
    return await emitProposalResponse({
      action: "error",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
