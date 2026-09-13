import type {
  DocumentFeedbackIndexTarget,
  DocumentFeedbackIndexUpdate,
} from "../../shared/documentFeedbackIndex";
import { documentFeedbackTargetKey } from "../../shared/documentFeedbackIndex";
import type { database } from "../database/PGLiteDatabaseWorker";

interface Dependencies {
  query: typeof database.query;
  viewer(orgId: string): Promise<string | null>;
  emit(update: DocumentFeedbackIndexUpdate): void;
}

/** Serializes viewer-scoped cache writes and validates the live team identity. */
export class DocumentFeedbackIndexService {
  private queues = new Map<string, Promise<unknown>>();
  private current = new Map<string, DocumentFeedbackIndexUpdate>();
  constructor(private deps: Dependencies) {}
  replace(update: DocumentFeedbackIndexUpdate): Promise<void> {
    const { workspacePath, orgId, teamMemberId, state } = update;
    if (
      !workspacePath ||
      !orgId ||
      !teamMemberId ||
      !state?.epoch ||
      !Number.isSafeInteger(state.sequence) ||
      !Array.isArray(state.entries) ||
      state.entries.some((entry) => entry.orgId !== orgId)
    )
      return Promise.reject(new Error("Invalid document feedback index scope"));
    const key = documentFeedbackTargetKey(update);
    const result = (this.queues.get(key) ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        const previous = this.current.get(key);
        const clearing =
          state.status === "disconnected" &&
          previous?.teamMemberId === teamMemberId &&
          previous.state.epoch === state.epoch;
        // Logout may have removed the JWT already. Clearing that connection's own
        // projection needs no credentials and must not clear a newer connection.
        if (!clearing && (await this.deps.viewer(orgId)) !== teamMemberId)
          throw new Error("Document feedback index viewer changed");
        if (state.status === "disconnected" && previous && !clearing) return;
        // Only a connection-start event can replace the active epoch. A late
        // snapshot from the retired socket cannot revive its cached projection.
        if (
          previous &&
          previous.state.epoch !== state.epoch &&
          state.status !== "connecting"
        )
          return;
        if (
          previous?.teamMemberId === teamMemberId &&
          previous.state.epoch === state.epoch &&
          previous.state.sequence >= state.sequence
        )
          return;
        // Hide removals and identity changes immediately; persistence cannot hold stale rows on screen.
        const next =
          state.status === "disconnected"
            ? { ...update, state: { ...state, entries: [] } }
            : update;
        this.current.set(key, next);
        this.deps.emit(next);
        await this.deps.query(
          `INSERT INTO document_feedback_index_cache (workspace_path, org_id, viewer_user_id, data)
        VALUES ($1, $2, $3, $4) ON CONFLICT (workspace_path, org_id, viewer_user_id) DO UPDATE SET data = excluded.data`,
          [workspacePath, orgId, teamMemberId, JSON.stringify(next.state)]
        );
      });
    this.queues.set(key, result);
    return result.finally(() => {
      if (this.queues.get(key) === result) this.queues.delete(key);
    });
  }
  async list(
    target: Pick<DocumentFeedbackIndexTarget, "workspacePath" | "orgId">
  ): Promise<void> {
    if (!target.workspacePath || !target.orgId)
      throw new Error(
        "Document feedback index workspace and organization are required"
      );
    const current = this.current.get(documentFeedbackTargetKey(target));
    // Persisted rows are never promoted to current authorization after a restart.
    if (
      current &&
      (await this.deps.viewer(target.orgId)) === current.teamMemberId
    )
      this.deps.emit(current);
  }
}
