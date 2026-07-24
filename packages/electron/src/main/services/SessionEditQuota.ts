import { SessionFilesRepository } from '@nimbalyst/runtime';
import { logger } from '../utils/logger';

/**
 * Maximum number of distinct files a single session may have tracked as
 * `edited` before further attribution is suppressed. Guards against a single
 * session slowly accumulating thousands of file links (generated code,
 * pre-`git init` workspaces where build artifacts aren't yet covered by
 * .gitignore, runaway scripts, etc.) and dragging PGLite down.
 */
export const MAX_EDITED_FILES_PER_SESSION = 500;

class SessionEditQuotaImpl {
  /**
   * Hydrated sets of tracked absolute file paths, keyed by sessionId. The
   * value is a Promise so concurrent first-touches share the DB load.
   */
  private readonly bySession = new Map<string, Promise<Set<string>>>();

  /** Sessions for which we've already logged a cap-reached warning. */
  private readonly warned = new Set<string>();

  private load(sessionId: string): Promise<Set<string>> {
    const existing = this.bySession.get(sessionId);
    if (existing) return existing;
    const promise = (async () => {
      try {
        const links = await SessionFilesRepository.getFilesBySession(sessionId, 'edited');
        const set = new Set<string>();
        for (const link of links) {
          set.add(link.filePath);
        }
        return set;
      } catch (err) {
        logger.main.warn('[SessionEditQuota] Hydration failed; starting with empty set:', {
          sessionId,
          err,
        });
        return new Set<string>();
      }
    })();
    this.bySession.set(sessionId, promise);
    return promise;
  }

  /**
   * Reserve quota for an edit of `filePath` by `sessionId`. Returns true if
   * the caller should proceed with the attribution write (the file was
   * already counted, or the session has room for another distinct file).
   * Returns false once the session has hit its distinct-file cap; the caller
   * should skip both `addFileLink` and any `historyManager.createTag` work.
   */
  async tryReserve(sessionId: string, filePath: string): Promise<boolean> {
    const set = await this.load(sessionId);
    if (set.has(filePath)) return true;
    if (set.size >= MAX_EDITED_FILES_PER_SESSION) {
      if (!this.warned.has(sessionId)) {
        this.warned.add(sessionId);
        logger.main.warn('[SessionEditQuota] Edit cap reached; suppressing further attribution:', {
          sessionId,
          cap: MAX_EDITED_FILES_PER_SESSION,
          attemptedFilePath: filePath,
        });
      }
      return false;
    }
    set.add(filePath);
    return true;
  }

  /** Drop in-memory state for a session (e.g. on session deletion). */
  clear(sessionId: string): void {
    this.bySession.delete(sessionId);
    this.warned.delete(sessionId);
  }

  /** Test/diagnostic: reset all in-memory state. */
  resetForTesting(): void {
    this.bySession.clear();
    this.warned.clear();
  }
}

export const sessionEditQuota = new SessionEditQuotaImpl();
