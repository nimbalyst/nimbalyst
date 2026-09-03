import type Store from 'electron-store';
import type { SessionManager } from '@nimbalyst/runtime/ai/server';
import type { ToolHandler, DocumentContext } from '@nimbalyst/runtime/ai/server/types';
import type { DocumentContextService } from '@nimbalyst/runtime/ai/services/DocumentContextService';
import type { MessageStreamingHandler, SendMessageHandler } from '../MessageStreamingHandler';
import type { HooklessAgentFileWatcher } from '../HooklessAgentFileWatcher';
import type { DriveOutcome, DriveReason } from '../QueueDriveService';
import type { ProviderWorkflowCatalog } from '../providerWorkflowCatalog';
import type { InterruptCurrentTurnResult } from '../AIService';

/**
 * The AIService members its IPC handlers actually use.
 *
 * `setupIpcHandlers()` builds a single object literal of this type and passes
 * it to each `registerXxx(ctx)` module, which closes over `ctx` instead of
 * `this`. The 2,500 lines of inlined handlers only ever touched the 26 members
 * below, so this is the whole seam.
 *
 * Deliberately different from `MessageStreamingHandler`'s `AIServiceInternal`,
 * which *casts* the service into its shape: a cast makes drift between class
 * and interface silent. An object literal is completeness-checked, so a missed
 * or misnamed member during the extraction is a compile error rather than a
 * runtime `undefined is not a function` in a handler nobody exercises until a
 * user hits it.
 */
export interface AIServiceContext {
  // --- shared state -------------------------------------------------------
  sessionManager: SessionManager;
  analytics: { sendEvent(event: string, props?: any): void };
  /**
   * Read at registration time by `ai:sendMessage`, so it is non-null here even
   * though AIService's own field starts null — the service assigns it from
   * `streamingHandler.handle` before building this context.
   */
  sendMessageHandler: SendMessageHandler;
  /**
   * Sessions with a queued-prompt chain in flight. Typed as the plain `Set` the
   * readers need; the concrete value is a `SessionProcessingGuard`, whose
   * `delete()` also clears the ownership lease. Handlers here only ever release
   * unconditionally — cancel and interrupt are authoritative — and that release
   * is what makes the displaced dispatch's own release a no-op (#1018).
   */
  sessionsProcessingQueue: Set<string>;
  documentContextService: DocumentContextService;
  streamingHandler: MessageStreamingHandler;
  hooklessWatcher: HooklessAgentFileWatcher;

  // --- settings / provider resolution -------------------------------------
  getSettingsStore(): Store<Record<string, unknown>>;
  getApiKeyForProvider(provider: string, workspacePath?: string): string | undefined;
  getProviderSetting(provider: string, key: string): any;
  getNormalizedProviderSettings(): Record<string, any>;
  normalizeProviderSettings(providerSettings: Record<string, any>): Record<string, any>;
  /**
   * Drops the memoized normalized-provider-settings snapshot. Handler modules
   * cannot write AIService's private `cachedNormalizedProviderSettings`, so the
   * invalidation `ai:saveSettings` performs inline today comes through here.
   */
  invalidateNormalizedProviderSettingsCache(): void;
  isProviderEnabledForWorkspace(provider: string, workspacePath?: string): boolean;
  getProviderWorkflowCatalog(request: {
    sessionId?: string;
    provider?: string | null;
  }): ProviderWorkflowCatalog;
  maskApiKey(key: string): string;
  maskApiKeys(keys: Record<string, string>): Record<string, string>;

  // --- queue + turn control -----------------------------------------------
  publishQueueStateToSync(sessionId: string): Promise<void>;
  driveQueuedPrompts(
    sessionId: string,
    workspacePath: string,
    reason: DriveReason,
  ): Promise<DriveOutcome>;
  forceSessionIdleOnCancel(sessionId: string): Promise<void>;
  interruptCurrentTurn(sessionId: string): Promise<InterruptCurrentTurnResult>;

  // --- misc ---------------------------------------------------------------
  createToolHandler(
    webContents: Electron.WebContents,
    documentContext?: DocumentContext,
    sessionId?: string,
    workspaceId?: string,
  ): ToolHandler;
  advanceDiffBaseline(sessionId: string, filePath: string, content: string): void;
}
