/**
 * SuperLoopProgressService - Manages the Super Loop Progress MCP server
 *
 * This runs in the electron main process and provides the super_loop_progress_update
 * tool to Claude during Super Loop iterations. The tool replaces direct progress.json
 * file writes with an MCP-based approach that can be verified.
 */

import {
  startSuperLoopProgressServer,
  setProgressUpdateFn,
  shutdownSuperLoopProgressServer,
} from '../mcp/superLoopProgressServer';
import { getSuperLoopService } from './SuperLoopService';
import type { SuperProgressFile } from '../../shared/types/superLoop';

export class SuperLoopProgressService {
  private static instance: SuperLoopProgressService | null = null;
  private serverPort: number | null = null;
  private starting: Promise<void> | null = null;
  private started: boolean = false;

  /**
   * Maps sessionId -> worktreePath for active Super Loop iterations.
   * Populated by SuperLoopService when starting an iteration,
   * cleared after the iteration completes.
   */
  private sessionWorktreePaths = new Map<string, string>();

  private constructor() {}

  public static getInstance(): SuperLoopProgressService {
    if (!SuperLoopProgressService.instance) {
      SuperLoopProgressService.instance = new SuperLoopProgressService();
    }
    return SuperLoopProgressService.instance;
  }

  /**
   * Register a session's worktree path so the progress update callback
   * can find where to write progress.json.
   * Called by SuperLoopService.runIteration() before emitting the prompt.
   */
  public registerSession(sessionId: string, worktreePath: string): void {
    this.sessionWorktreePaths.set(sessionId, worktreePath);
  }

  /**
   * Unregister a session's worktree path after the iteration completes.
   */
  public unregisterSession(sessionId: string): void {
    this.sessionWorktreePaths.delete(sessionId);
  }

  /**
   * Start the Super Loop Progress MCP server and configure agent providers
   */
  public async start(): Promise<void> {
    if (this.started) {
      return;
    }

    if (this.starting) {
      await this.starting;
      return;
    }

    this.starting = (async () => {
      try {
        // Set the progress update function that the MCP tool will call
        setProgressUpdateFn(async (sessionId: string, progress: SuperProgressFile) => {
          const worktreePath = this.sessionWorktreePaths.get(sessionId);
          if (!worktreePath) {
            throw new Error(`No worktree path registered for session: ${sessionId}`);
          }

          // Delegate to SuperLoopService to write progress.json atomically
          const superLoopService = getSuperLoopService();
          await superLoopService.writeProgressFile(worktreePath, progress);
        });

        // Start the MCP server
        const { port } = await startSuperLoopProgressServer();
        this.serverPort = port;
        console.log(`[SuperLoopProgressService] MCP server started on port ${port}`);

        // NOTE: the super-loop progress server is not registered in the agent MCP
        // config (it was disabled — leaked into non-super-loop sessions), so there
        // is no per-provider port to inject. See McpConfigService.

        this.started = true;
      } catch (error) {
        console.error('[SuperLoopProgressService] Failed to start:', error);
        throw error;
      } finally {
        this.starting = null;
      }
    })();

    await this.starting;
  }

  /**
   * Shutdown the Super Loop Progress MCP server
   */
  public async shutdown(): Promise<void> {
    if (!this.started) {
      return;
    }

    try {
      await shutdownSuperLoopProgressServer();
      this.serverPort = null;
      this.sessionWorktreePaths.clear();
      this.started = false;
      console.log('[SuperLoopProgressService] Shutdown complete');
    } catch (error) {
      console.error('[SuperLoopProgressService] Error during shutdown:', error);
    }
  }
}
