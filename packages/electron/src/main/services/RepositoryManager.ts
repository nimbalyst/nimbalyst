/**
 * Central repository manager for the Electron app
 * Provides concrete implementations of all runtime interfaces
 */

import type {
  SessionStore,
  SessionFileStore,
  DocumentsRepository
} from '@nimbalyst/runtime';
import type { WorkspaceRepository } from '../types/workspace';
import type { AgentMessagesStore } from '@nimbalyst/runtime/storage/repositories/AgentMessagesRepository';
import { AISessionsRepository, SessionFilesRepository, AgentMessagesRepository, TranscriptMigrationRepository } from '@nimbalyst/runtime';
import { TranscriptMigrationService } from '@nimbalyst/runtime/ai/server/transcript/TranscriptMigrationService';
import { createRawMessageStoreAdapter } from './TranscriptMigrationAdapters';
import { createPGLiteSessionStore } from './PGLiteSessionStore';
import { createPGLiteSessionFileStore } from './PGLiteSessionFileStore';
import { createPGLiteAgentMessagesStore } from './PGLiteAgentMessagesStore';
import { createSyncedAgentMessagesStore } from './SyncedAgentMessagesStore';
import { createPGLiteWorkspaceRepository } from './PGLiteWorkspaceRepository';
import { createPGLiteDocumentsRepository } from './PGLiteDocumentsRepository';
import { createPGLiteQueuedPromptsStore, type QueuedPromptsStore } from './PGLiteQueuedPromptsStore';
import { createHostControlReceiptsStore, type HostControlReceiptsStore } from './HostControlReceiptsStore';
import { createPGLiteSessionWakeupsStore, type SessionWakeupsStore } from './PGLiteSessionWakeupsStore';
import { configureNativeWinnerNotificationStore } from './NativeWinnerNotificationService';
import { runAgentMessagesBackfill } from './AgentMessagesBackfill';
import { runWhenFirstUsable } from './startupMaintenanceGate';
import { database } from '../database/PGLiteDatabaseWorker';
import { createSQLiteStoreAdapter } from '../database/sqlite/SQLiteStoreAdapter';
import { logger } from '../utils/logger';
import { initializeSync, shutdownSync, isSyncEnabled, reinitializeSync } from './SyncManager';
import { shutdownTrackerSync, initializeTrackerSync } from './TrackerSyncManager';
import { onAuthStateChange } from './StytchAuthService';
import { windows, windowStates } from '../window/WindowManager';

class RepositoryManager {
  private sessionStore: SessionStore | null = null;
  private baseSessionStore: SessionStore | null = null; // Unwrapped store for sync reinitialization
  private sessionFileStore: SessionFileStore | null = null;
  private agentMessagesStore: AgentMessagesStore | null = null;
  private baseAgentMessagesStore: AgentMessagesStore | null = null; // Unwrapped store for sync reinitialization
  private workspaceRepository: WorkspaceRepository | null = null;
  private documentsRepository: DocumentsRepository | null = null;
  private queuedPromptsStore: QueuedPromptsStore | null = null;
  private hostControlReceiptsStore: HostControlReceiptsStore | null = null;
  private sessionWakeupsStore: SessionWakeupsStore | null = null;
  private initialized = false;
  private authListenerUnsubscribe: (() => void) | null = null;
  private wasAuthenticated = false; // Track auth state to detect transitions

  /**
   * Initialize all repositories with PGLite database
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      logger.main.info('[RepositoryManager] Initializing repositories...');

      // Ensure database is ready
      if (!database.isInitialized()) {
        await database.initialize();
      }

      // Create database adapter
      const sqliteDatabase = database.getActiveSQLiteDatabase();
      const dbAdapter = sqliteDatabase
        ? createSQLiteStoreAdapter(sqliteDatabase)
        : { query: database.query.bind(database) };

      // Create base session store
      this.baseSessionStore = createPGLiteSessionStore(
        dbAdapter,
        async () => {
          if (!database.isInitialized()) {
            await database.initialize();
          }
        }
      );

      // Wrap with sync if configured (returns base store if sync not enabled)
      this.sessionStore = await initializeSync(this.baseSessionStore);

      // Register session store with runtime's AISessionsRepository
      AISessionsRepository.setStore(this.sessionStore);

      // Create session file store
      this.sessionFileStore = createPGLiteSessionFileStore(
        dbAdapter,
        async () => {
          if (!database.isInitialized()) {
            await database.initialize();
          }
        }
      );

      // Register session file store with runtime's SessionFilesRepository
      SessionFilesRepository.setStore(this.sessionFileStore);

      // Create base agent messages store
      this.baseAgentMessagesStore = createPGLiteAgentMessagesStore(
        dbAdapter,
        async () => {
          if (!database.isInitialized()) {
            await database.initialize();
          }
        }
      );

      // Wrap with sync if enabled (must happen after initializeSync)
      this.agentMessagesStore = isSyncEnabled()
        ? createSyncedAgentMessagesStore(this.baseAgentMessagesStore)
        : this.baseAgentMessagesStore;

      // Register agent messages store with runtime's AgentMessagesRepository
      AgentMessagesRepository.setStore(this.agentMessagesStore);

      // Create workspace repository
      this.workspaceRepository = createPGLiteWorkspaceRepository(dbAdapter);

      // Create documents repository
      this.documentsRepository = createPGLiteDocumentsRepository(dbAdapter);

      // Create queued prompts store
      this.queuedPromptsStore = createPGLiteQueuedPromptsStore(
        dbAdapter,
        async () => {
          if (!database.isInitialized()) {
            await database.initialize();
          }
        }
      );

      this.hostControlReceiptsStore = createHostControlReceiptsStore(
        dbAdapter,
        async () => {
          if (!database.isInitialized()) {
            await database.initialize();
          }
        },
      );
      configureNativeWinnerNotificationStore(this.hostControlReceiptsStore);

      // Create session wakeups store (scheduled re-invocations)
      this.sessionWakeupsStore = createPGLiteSessionWakeupsStore(
        dbAdapter,
        async () => {
          if (!database.isInitialized()) {
            await database.initialize();
          }
        }
      );

      // Phase 4 of canonical-transcript-deprecation: canonical events live
      // in TranscriptRuntime's in-memory per-session MRU cache. There is no
      // persisted store to register, and no metadata adapter is needed.
      const rawMessageStore = createRawMessageStoreAdapter();
      const migrationService = new TranscriptMigrationService(rawMessageStore);
      TranscriptMigrationRepository.setService(migrationService);

      // Wire up real-time canonical event notification to renderer windows.
      // The TranscriptTransformer fires this callback after writing each canonical event
      // (both during batch migration and incremental processNewMessages).
      migrationService.setOnEventWritten((event) => {
        for (const win of windows.values()) {
          try {
            win.webContents.send('transcript:event', event);
          } catch {
            // Window may be destroyed
          }
        }
      });

      this.initialized = true;
      logger.main.info('[RepositoryManager] All repositories initialized successfully');

      // Phase 1C/5 of canonical-transcript-deprecation: backfill
      // searchable_text/message_kind on existing rows and delete transient
      // claude-code chunks. Idempotent. Deferred until the app is first-usable
      // (first window painted + idle) so it never competes with the queries
      // that load the first window -- the shared SQLite worker is FIFO and a
      // long maintenance query head-of-line-blocks everything queued behind it.
      // NIM-899.
      runWhenFirstUsable('agent-messages-backfill', () => runAgentMessagesBackfill(dbAdapter));

      // Subscribe to auth state changes to reinitialize sync when user authenticates
      // This handles the case where Stytch is lazy-initialized after repositories are ready
      this.authListenerUnsubscribe = onAuthStateChange((authState) => {
        const isNowAuthenticated = authState.isAuthenticated && !!authState.user?.user_id;

        // Only reinitialize sync when transitioning from not-authenticated to authenticated
        // and sync is not already enabled
        if (isNowAuthenticated && !this.wasAuthenticated && !isSyncEnabled()) {
          logger.main.info('[RepositoryManager] Auth state changed to authenticated, reinitializing sync...');
          this.reinitializeSyncWithNewConfig().catch(err => {
            logger.main.error('[RepositoryManager] Failed to reinitialize sync after auth:', err);
          });
        }

        this.wasAuthenticated = isNowAuthenticated;
      });
    } catch (error) {
      logger.main.error('[RepositoryManager] Failed to initialize repositories:', error);
      throw error;
    }
  }

  /**
   * Get the session store instance (potentially wrapped with sync)
   */
  getSessionStore(): SessionStore {
    if (!this.sessionStore) {
      throw new Error('RepositoryManager not initialized. Call initialize() first.');
    }
    return this.sessionStore;
  }

  /**
   * Get the base session store (without sync wrapper)
   * Used for methods like claimQueuedPrompt that are specific to PGLite
   */
  getBaseSessionStore(): SessionStore {
    if (!this.baseSessionStore) {
      throw new Error('RepositoryManager not initialized. Call initialize() first.');
    }
    return this.baseSessionStore;
  }

  /**
   * Get the workspace repository instance
   */
  getWorkspaceRepository(): WorkspaceRepository {
    if (!this.workspaceRepository) {
      throw new Error('RepositoryManager not initialized. Call initialize() first.');
    }
    return this.workspaceRepository;
  }

  /**
   * Get the documents repository instance
   */
  getDocumentsRepository(): DocumentsRepository {
    if (!this.documentsRepository) {
      throw new Error('RepositoryManager not initialized. Call initialize() first.');
    }
    return this.documentsRepository;
  }

  /**
   * Check if repositories are initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Get the session file store instance
   */
  getSessionFileStore(): SessionFileStore {
    if (!this.sessionFileStore) {
      throw new Error('RepositoryManager not initialized. Call initialize() first.');
    }
    return this.sessionFileStore;
  }

  /**
   * Get the agent messages store instance
   */
  getAgentMessagesStore(): AgentMessagesStore {
    if (!this.agentMessagesStore) {
      throw new Error('RepositoryManager not initialized. Call initialize() first.');
    }
    return this.agentMessagesStore;
  }

  /**
   * Get the base (unwrapped) agent messages store.
   * Use this when saving messages from sync to avoid feedback loops.
   */
  getBaseAgentMessagesStore(): AgentMessagesStore {
    if (!this.baseAgentMessagesStore) {
      throw new Error('RepositoryManager not initialized. Call initialize() first.');
    }
    return this.baseAgentMessagesStore;
  }

  /**
   * Get the queued prompts store instance.
   * Used for atomic prompt claiming and queue management.
   */
  getQueuedPromptsStore(): QueuedPromptsStore {
    if (!this.queuedPromptsStore) {
      throw new Error('RepositoryManager not initialized. Call initialize() first.');
    }
    return this.queuedPromptsStore;
  }

  getHostControlReceiptsStore(): HostControlReceiptsStore {
    if (!this.hostControlReceiptsStore) {
      throw new Error('RepositoryManager not initialized. Call initialize() first.');
    }
    return this.hostControlReceiptsStore;
  }

  /**
   * Get the session wakeups store instance.
   * Used by SessionWakeupScheduler and IPC handlers.
   */
  getSessionWakeupsStore(): SessionWakeupsStore {
    if (!this.sessionWakeupsStore) {
      throw new Error('RepositoryManager not initialized. Call initialize() first.');
    }
    return this.sessionWakeupsStore;
  }

  /**
   * Reinitialize sync with new configuration.
   * Called when sync settings are changed at runtime.
   */
  async reinitializeSyncWithNewConfig(): Promise<void> {
    logger.main.info('[RepositoryManager] reinitializeSyncWithNewConfig called', {
      initialized: this.initialized,
      hasBaseSessionStore: !!this.baseSessionStore,
      hasBaseAgentMessagesStore: !!this.baseAgentMessagesStore,
    });

    if (!this.initialized || !this.baseSessionStore || !this.baseAgentMessagesStore) {
      logger.main.warn('[RepositoryManager] Cannot reinitialize sync - not initialized yet');
      return;
    }

    logger.main.info('[RepositoryManager] Reinitializing sync with new configuration...');

    // Reinitialize sync (this shuts down existing sync and starts new one if enabled)
    this.sessionStore = await reinitializeSync(this.baseSessionStore);
    AISessionsRepository.setStore(this.sessionStore);

    // Rewrap agent messages store with sync if enabled
    this.agentMessagesStore = isSyncEnabled()
      ? createSyncedAgentMessagesStore(this.baseAgentMessagesStore)
      : this.baseAgentMessagesStore;
    AgentMessagesRepository.setStore(this.agentMessagesStore);

    logger.main.info('[RepositoryManager] Sync reinitialization complete, sync enabled:', isSyncEnabled());

    // Also reinitialize tracker sync for all open workspaces
    // Tracker sync requires a workspace path (for project identity via git remote)
    for (const state of windowStates.values()) {
      if (state.workspacePath) {
        initializeTrackerSync(state.workspacePath).catch(err => {
          logger.main.error('[RepositoryManager] Failed to initialize tracker sync for workspace:', err);
        });
      }
    }
  }

  /**
   * Clean up resources
   */
  async cleanup(): Promise<void> {
    // Unsubscribe from auth state changes
    if (this.authListenerUnsubscribe) {
      this.authListenerUnsubscribe();
      this.authListenerUnsubscribe = null;
    }

    // Shutdown sync first
    shutdownTrackerSync();
    shutdownSync();

    if (this.sessionStore) {
      AISessionsRepository.clearStore();
    }
    if (this.sessionFileStore) {
      SessionFilesRepository.clearStore();
    }
    if (this.agentMessagesStore) {
      AgentMessagesRepository.clearStore();
    }
    TranscriptMigrationRepository.clearService();
    this.sessionStore = null;
    this.sessionFileStore = null;
    this.agentMessagesStore = null;
    this.workspaceRepository = null;
    this.documentsRepository = null;
    this.queuedPromptsStore = null;
    this.hostControlReceiptsStore = null;
    configureNativeWinnerNotificationStore(null);
    this.sessionWakeupsStore = null;
    this.initialized = false;
    this.wasAuthenticated = false;
  }
}

// Export singleton instance
export const repositoryManager = new RepositoryManager();

// Export convenience getters
export function getSessionStore(): SessionStore {
  return repositoryManager.getSessionStore();
}

export function getBaseSessionStore(): SessionStore {
  return repositoryManager.getBaseSessionStore();
}

export function getWorkspaceRepository(): WorkspaceRepository {
  return repositoryManager.getWorkspaceRepository();
}

export function getDocumentsRepository(): DocumentsRepository {
  return repositoryManager.getDocumentsRepository();
}

export function getSessionFileStore(): SessionFileStore {
  return repositoryManager.getSessionFileStore();
}

export function getAgentMessagesStore(): AgentMessagesStore {
  return repositoryManager.getAgentMessagesStore();
}

export function getBaseAgentMessagesStore(): AgentMessagesStore {
  return repositoryManager.getBaseAgentMessagesStore();
}

export function getQueuedPromptsStore(): QueuedPromptsStore {
  return repositoryManager.getQueuedPromptsStore();
}

export function getHostControlReceiptsStore(): HostControlReceiptsStore {
  return repositoryManager.getHostControlReceiptsStore();
}

export function getSessionWakeupsStore(): SessionWakeupsStore {
  return repositoryManager.getSessionWakeupsStore();
}
