import { BrowserWindow } from 'electron';
import { SessionManager, setPreferredAgentLanguage as setRuntimePreferredAgentLanguage } from '@nimbalyst/runtime/ai/server';
import { AISessionsRepository } from '@nimbalyst/runtime';
import { setClaudeCliAutoNameApplyTitleFn } from './ai/claudeCliSessionAutoNameSingleton';
import {
  setUpdateSessionTitleFn,
  setUpdateSessionMetadataFn,
  setGetSessionTagsFn,
  setGetSessionTitleFn,
  setGetSessionPhaseFn,
} from '../mcp/sessionNamingServer';
import { getDatabase } from '../database/initialize';
import { createWorktreeStore } from './WorktreeStore';
import { getPreferredAgentLanguage } from '../utils/store';
import { normalizeSessionPhaseMetadataUpdate } from './session/sessionPhaseTransition';

/**
 * Service to manage the session naming MCP server
 * This runs in the electron main process and coordinates with agent providers
 */
export class SessionNamingService {
  private static instance: SessionNamingService | null = null;
  private serverPort: number | null = null;
  private starting: Promise<void> | null = null;
  private started: boolean = false;
  private sessionManager: SessionManager | null = null;

  private constructor() {}

  public static getInstance(): SessionNamingService {
    if (!SessionNamingService.instance) {
      SessionNamingService.instance = new SessionNamingService();
    }
    return SessionNamingService.instance;
  }

  /**
   * Start the session naming MCP server and configure agent providers
   */
  public async start(): Promise<void> {
    // If already started, do nothing
    if (this.started) {
      return;
    }

    // If already starting, wait for it
    if (this.starting) {
      await this.starting;
      return;
    }

    this.starting = (async () => {
      try {
        // Initialize session manager
        this.sessionManager = new SessionManager();
        await this.sessionManager.initialize();

        // Push the configured preferred-agent language to the runtime so
        // providers and prompt builders can read it without an electron-store
        // dependency. Renderer changes call SessionNamingService.setLanguage()
        // to keep this in sync at runtime.
        setRuntimePreferredAgentLanguage(getPreferredAgentLanguage());

        // Set the update function that will be called by the MCP server.
        // The body lives in applySessionTitle so the CLI auto-namer (NIM-822)
        // can reuse the exact same broadcast/propagation path.
        setUpdateSessionTitleFn((sessionId: string, title: string) =>
          this.applySessionTitle(sessionId, title)
        );
        setClaudeCliAutoNameApplyTitleFn((sessionId: string, title: string) =>
          this.applySessionTitle(sessionId, title)
        );

        // Set the metadata update function (for tags, phase, etc.)
        setUpdateSessionMetadataFn(async (sessionId: string, metadata: Record<string, unknown>) => {
          const normalizedMetadata = normalizeSessionPhaseMetadataUpdate(metadata);
          // SyncedSessionStore.updateMetadata is the single source of truth for
          // what reaches other devices; phase/tags forwarding lives there now.
          await AISessionsRepository.updateMetadata(sessionId, { metadata: normalizedMetadata });

          // Notify renderer windows so UI updates in real time
          const windows = BrowserWindow.getAllWindows();
          for (const window of windows) {
            if (!window.isDestroyed()) {
              window.webContents.send('sessions:session-updated', sessionId, normalizedMetadata);
            }
          }
        });

        // Set the session tags query function (for reading current tags)
        setGetSessionTagsFn(async (sessionId: string) => {
          const session = await AISessionsRepository.get(sessionId);
          return (session?.metadata as any)?.tags || [];
        });

        // Set the session title query function (for reading current name)
        setGetSessionTitleFn(async (sessionId: string) => {
          const session = await AISessionsRepository.get(sessionId);
          return session?.title || null;
        });

        // Set the session phase query function (for reading current phase)
        setGetSessionPhaseFn(async (sessionId: string) => {
          const session = await AISessionsRepository.get(sessionId);
          return (session?.metadata as any)?.phase || null;
        });

        // MCP consolidation Phase 7: `update_session_meta` is served by the
        // unified server's eager core (`/mcp/core`) via the dispatch fn in
        // sessionNamingServer.ts; this service no longer starts a standalone
        // HTTP server. It still injects the title/metadata/query fns above, which
        // that dispatch (and the auto-namer) call.
        this.started = true;
      } catch (error) {
        console.error('[SessionNamingService] Failed to start:', error);
        throw error;
      } finally {
        this.starting = null;
      }
    })();

    await this.starting;
  }

  /**
   * Apply a session title with full propagation: blitz-parent first-wins
   * naming, worktree display name, and renderer broadcasts. Called by the
   * naming MCP server (agent-chosen titles) and by the claude-code-cli
   * auto-namer (NIM-822). Renames are allowed; the agent prompt instructs the
   * agent not to rename a named session unless the user asks.
   */
  public async applySessionTitle(sessionId: string, title: string): Promise<void> {
    const sessionManager = this.sessionManager;
    if (!sessionManager) {
      console.warn('[SessionNamingService] applySessionTitle before start(); skipping');
      return;
    }
    const windows = BrowserWindow.getAllWindows();

    // Check if this session belongs to a blitz (parent_session_id points to a blitz session)
    let parentBlitzId: string | undefined;
    let worktreeId: string | undefined;

    try {
      const session = await AISessionsRepository.get(sessionId);
      worktreeId = session?.worktreeId;

      if (session?.parentSessionId) {
        const parent = await AISessionsRepository.get(session.parentSessionId);
        if (parent?.sessionType === 'blitz') {
          parentBlitzId = parent.id;
        }
      }
    } catch (error) {
      console.error('[SessionNamingService] Failed to check blitz membership:', error);
    }

    if (parentBlitzId) {
      // Blitz child session: propagate AI-chosen name to blitz parent (first-wins),
      // but keep the child's model-based title unchanged
      try {
        const updated = await AISessionsRepository.updateTitleIfNotNamed(parentBlitzId, title);
        if (updated) {
          console.log(`[SessionNamingService] Updated blitz ${parentBlitzId} display name to: "${title}"`);
          for (const window of windows) {
            window.webContents.send('blitz:display-name-updated', {
              blitzId: parentBlitzId,
              displayName: title
            });
          }
        }
      } catch (error) {
        console.error('[SessionNamingService] Failed to update blitz display name:', error);
      }

      // Mark child as named so update_session_meta won't set name again, but keep model-based title
      await AISessionsRepository.updateMetadata(sessionId, { hasBeenNamed: true } as any);
      return;
    }

    // Normal (non-blitz) session: update title and propagate to worktree.
    await sessionManager.updateSessionTitle(sessionId, title, { force: true, markAsNamed: true });
    for (const window of windows) {
      window.webContents.send('session:title-updated', { sessionId, title });
    }

    // Propagate to worktree display name
    if (worktreeId) {
      try {
        const db = getDatabase();
        if (db) {
          const worktreeStore = createWorktreeStore(db);
          const updated = await worktreeStore.updateDisplayNameIfEmpty(worktreeId, title);
          if (updated) {
            console.log(`[SessionNamingService] Updated worktree ${worktreeId} display name to: "${title}"`);
            for (const window of windows) {
              window.webContents.send('worktree:display-name-updated', {
                worktreeId,
                displayName: title
              });
            }
          }
        }
      } catch (error) {
        console.error('[SessionNamingService] Failed to update worktree display name:', error);
      }
    }
  }

  /**
   * Update the preferred agent language. The language is pushed into the
   * runtime so providers and prompt builders read the new value on the next
   * session turn (no restart required).
   */
  public setLanguage(language: string | undefined): void {
    setRuntimePreferredAgentLanguage(language);
  }

  /**
   * Shutdown the session naming MCP server
   */
  public async shutdown(): Promise<void> {
    if (!this.started) {
      return;
    }

    try {
      // No standalone HTTP server to tear down (Phase 7); the injected fns are
      // process-lifetime singletons. Just flip the started flag.
      this.serverPort = null;
      this.started = false;
      console.log('[SessionNamingService] Shutdown complete');
    } catch (error) {
      console.error('[SessionNamingService] Error during shutdown:', error);
    }
  }

}
