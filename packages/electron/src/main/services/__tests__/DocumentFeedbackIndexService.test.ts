// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { SQLiteDatabase } from "../../database/sqlite/SQLiteDatabase";
import { DocumentFeedbackIndexService } from "../DocumentFeedbackIndexService";
import type { DocumentFeedbackIndexUpdate } from "../../../shared/documentFeedbackIndex";

const target = {
  workspacePath: "/workspace",
  orgId: "org",
  teamMemberId: "viewer",
};
function update(
  epoch: string,
  sequence: number,
  status: DocumentFeedbackIndexUpdate["state"]["status"]
): DocumentFeedbackIndexUpdate {
  return {
    ...target,
    state: {
      epoch,
      sequence,
      status,
      generation: sequence,
      entries:
        status === "ready"
          ? [
              {
                orgId: "org",
                documentId: "doc",
                projectId: "project",
                blockId: "block",
                title: "Question",
                sentBy: "author",
                sentAt: 1,
                updatedAt: 1,
                sealed: false,
                availability: "available",
                recipientCount: 1,
                answeredCount: 0,
                quorum: 1,
                isRecipient: true,
                needsMyResponse: true,
              },
            ]
          : [],
    },
  };
}

describe.each(["sqlite", "pglite"] as const)(
  "document Feedback cache on %s",
  (engine) => {
    it("fences old connections, clears logout without credentials, and recovers from an authenticated snapshot", async () => {
      const directory = mkdtempSync(
        path.join(tmpdir(), "document-feedback-cache-")
      );
      const db =
        engine === "sqlite"
          ? new SQLiteDatabase({
              dbDir: directory,
              schemaDir: path.resolve(
                __dirname,
                "../../database/sqlite/schemas"
              ),
            })
          : new PGlite();
      try {
        if (db instanceof SQLiteDatabase) await db.initialize();
        else
          await db.exec(
            `CREATE TABLE document_feedback_index_cache (workspace_path TEXT NOT NULL, org_id TEXT NOT NULL, viewer_user_id TEXT NOT NULL, data JSONB NOT NULL, PRIMARY KEY (workspace_path, org_id, viewer_user_id))`
          );
        let viewer: string | null = "viewer";
        const emitted: DocumentFeedbackIndexUpdate[] = [];
        const deps = {
          query: db.query.bind(db) as any,
          viewer: async () => viewer,
          emit: (value: DocumentFeedbackIndexUpdate) => emitted.push(value),
        };
        const service = new DocumentFeedbackIndexService(deps);
        await service.replace(update("old", 1, "connecting"));
        await service.replace(update("old", 2, "ready"));
        await service.replace(update("new", 1, "connecting"));
        await service.replace(update("new", 2, "ready"));
        await service.replace(update("old", 3, "ready"));
        expect(emitted.at(-1)?.state.epoch).toBe("new");
        await service.replace(update("new", 1, "ready"));
        expect(emitted.at(-1)?.state.sequence).toBe(2);
        const saved = await db.query<{ data: unknown }>(
          "SELECT data FROM document_feedback_index_cache"
        );
        const data =
          typeof saved.rows[0].data === "string"
            ? JSON.parse(saved.rows[0].data)
            : saved.rows[0].data;
        expect(data).toMatchObject({
          epoch: "new",
          entries: [expect.objectContaining({ title: "Question" })],
        });
        viewer = null;
        await service.replace(update("new", 3, "disconnected"));
        expect(emitted.at(-1)?.state.entries).toEqual([]);
        await expect(
          service.replace(update("new", 4, "ready"))
        ).rejects.toThrow("viewer changed");
        viewer = "viewer";
        const restarted = new DocumentFeedbackIndexService(deps);
        const before = emitted.length;
        await restarted.list(target);
        expect(emitted).toHaveLength(before);
        await restarted.replace(update("restart", 1, "connecting"));
        await restarted.replace(update("restart", 2, "ready"));
        expect(emitted.at(-1)?.state.entries).toHaveLength(1);
        viewer = "other-viewer";
        await expect(
          restarted.replace(update("restart", 3, "ready"))
        ).rejects.toThrow("viewer changed");
      } finally {
        await db.close();
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
);
