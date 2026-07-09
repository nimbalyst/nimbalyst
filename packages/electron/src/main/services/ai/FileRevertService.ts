/**
 * FileRevertService -- the "Reset chat + files" half of the edit/rewind
 * feature. Restores files the AI edited after the rewind target back to their
 * as-of-target content, using the bounded per-file snapshot history.
 *
 * Safety posture (deliberate): this service NEVER deletes files. Files the AI
 * created after the target (no recoverable prior snapshot) are reported in
 * `unrevertableFiles` for the user to remove manually, rather than auto-deleted
 * -- file deletion is the highest-blast-radius operation and the repo's
 * file-safety rules favour conservatism. Reverts overwrite through a plain write
 * and let the file watcher propagate the change to open editors (the same path
 * the app uses for any external file change).
 *
 * Precision is best-effort: snapshot retention is bounded, so a file edited long
 * before the target (with its pre-target snapshot already pruned) may fall back
 * to its pre-AI baseline.
 */

import * as fs from 'fs/promises';
import { database } from '../../database/PGLiteDatabaseWorker';
import { historyManager } from '../../HistoryManager';
import { logger } from '../../utils/logger';
import type { FileRevertCollaborator } from './RewindSessionService';

export class FileRevertService implements FileRevertCollaborator {
  async countFilesAfter(sessionId: string, afterMessageId: number): Promise<number> {
    const files = await this.queryFilesEditedAfter(sessionId, afterMessageId);
    return files.length;
  }

  async revertFilesAfter(params: {
    sessionId: string;
    workspacePath?: string;
    afterMessageId: number;
  }): Promise<{ revertedFiles: string[]; unrevertableFiles: string[] }> {
    const { sessionId, afterMessageId } = params;
    const revertedFiles: string[] = [];
    const unrevertableFiles: string[] = [];

    const files = await this.queryFilesEditedAfter(sessionId, afterMessageId);
    if (files.length === 0) {
      return { revertedFiles, unrevertableFiles };
    }

    const targetCreatedAtMs = await this.getMessageCreatedAtMs(sessionId, afterMessageId);

    for (const filePath of files) {
      try {
        let asOf: string | null = null;

        // Primary: newest in-session snapshot at or before the target's time =
        // the file's content as of message N (keeps pre-N edits, drops post-N).
        if (targetCreatedAtMs != null) {
          asOf = await historyManager.getSnapshotContentAsOf(filePath, sessionId, targetCreatedAtMs);
        }

        // Fallback: the file was first edited AFTER the target (its only snapshot
        // is later than N), so its as-of-N state is its pre-AI baseline.
        if (asOf == null) {
          asOf = await historyManager.getLatestSnapshotContent(filePath, sessionId, 'pre-edit');
        }

        if (asOf == null) {
          // No recoverable baseline -- the AI created this file after the target.
          // We do NOT delete it (file-safety); report it instead.
          unrevertableFiles.push(filePath);
          continue;
        }

        // Overwrite (or recreate, if deleted after N). The file watcher picks
        // this up as an external change and refreshes any open editor.
        await fs.writeFile(filePath, asOf, 'utf-8');
        revertedFiles.push(filePath);
      } catch (err) {
        logger.main.error(`[FileRevertService] failed to revert ${filePath}:`, err);
        unrevertableFiles.push(filePath);
      }
    }

    logger.main.info(
      `[FileRevertService] session ${sessionId}: reverted ${revertedFiles.length}, unrevertable ${unrevertableFiles.length}`,
    );
    return { revertedFiles, unrevertableFiles };
  }

  /** Distinct files edited by tool calls attributed to messages after N. */
  private async queryFilesEditedAfter(sessionId: string, afterMessageId: number): Promise<string[]> {
    if (!database.isInitialized()) {
      await database.initialize();
    }
    const { rows } = await database.query<{ file_path: string }>(
      `
        SELECT DISTINCT sf.file_path
        FROM ai_tool_call_file_edits atcfe
        JOIN session_files sf ON atcfe.session_file_id = sf.id
        WHERE atcfe.session_id = $1
          AND atcfe.message_id > $2
      `,
      [sessionId, afterMessageId],
    );
    return rows.map((r) => r.file_path).filter((p): p is string => Boolean(p));
  }

  private async getMessageCreatedAtMs(sessionId: string, messageId: number): Promise<number | null> {
    if (!database.isInitialized()) {
      await database.initialize();
    }
    const { rows } = await database.query<{ created_at: unknown }>(
      `SELECT created_at FROM ai_agent_messages WHERE session_id = $1 AND id = $2 LIMIT 1`,
      [sessionId, messageId],
    );
    if (rows.length === 0) return null;
    return toMillis(rows[0].created_at);
  }
}

/** Coerce a created_at value (Date | ISO string | epoch ms) to epoch ms. */
function toMillis(value: unknown): number | null {
  if (value == null) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}
