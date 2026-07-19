/**
 * MobilePromptDelivery
 *
 * One provider-agnostic driver for delivering an interactive prompt response
 * (from mobile sync or the voice agent) to whichever consumer is waiting:
 *   1. the durable DB record the pollers recover from,
 *   2. the in-process provider (when the prompt type has one),
 *   3. the MCP-over-IPC waiter (per-waiter channel + optional session fallback).
 *
 * The four stages are INDEPENDENT — persistence happens before any consumer is
 * woken, a provider consuming the response does not prevent the MCP waiter from
 * waking, and one delivery failure does not suppress later cleanup stages.
 *
 * Each `handleXxxResponse` builds a descriptor and calls the driver; the driver
 * resolves the session provider ONCE (killing the hardcoded `claude-code` that
 * misrouted plan-approval / tool-permission responses on non-claude-code
 * sessions — NIM-1661).
 */

import { ipcMain } from 'electron';
import {
  ProviderFactory,
  type AIProvider,
  type AIProviderType,
} from '@nimbalyst/runtime/ai/server';
import { AISessionsRepository, AgentMessagesRepository } from '@nimbalyst/runtime';
import { TrayManager } from '../../tray/TrayManager';
import { logger } from '../../utils/logger';
import {
  runClaimedPendingPromptAction,
  type PendingPromptPersistenceResult,
} from './pendingPromptPersistence';
import { attentionEventService } from '../AttentionEventService';
import { settleConfiguredInteractiveAttentionAfterResponse } from '../NativeWinnerNotificationService';

const log = logger.ai;

export interface ResolvedSessionProvider {
  providerType: AIProviderType;
  provider: AIProvider | null;
}

/**
 * Resolve a session's real provider once. Replaces the hardcoded
 * `getProvider('claude-code', …)` copies scattered across the mobile handlers.
 * Falls back to `claude-code` only when the session row can't be read.
 */
export async function resolveSessionProvider(
  sessionId: string,
): Promise<ResolvedSessionProvider> {
  let providerType: AIProviderType = 'claude-code';
  try {
    const session = await AISessionsRepository.get(sessionId);
    providerType = (session?.provider as AIProviderType) ?? providerType;
  } catch (err) {
    log.warn(`[Mobile] provider resolution failed for ${sessionId}: ${err}`);
  }
  return {
    providerType,
    provider: ProviderFactory.getProvider(providerType, sessionId),
  };
}

export type MobilePromptType =
  | 'ask_user_question'
  | 'request_user_input'
  | 'exit_plan_mode'
  | 'tool_permission'
  | 'git_commit';

export interface MobilePromptDeliveryDescriptor {
  /** For logs; also the caller's own record `type` lives in `dbRecord`. */
  promptType: MobilePromptType;
  sessionId: string;
  /** Stable prompt/request/tool identity used for race-safe clearing. */
  promptId: string;

  /**
   * Alias-expanded ids the MCP waiter / DB may key on (Codex synthetic → raw).
   * Omit for provider-only prompt types with no per-waiter IPC channel.
   */
  waiterIds?: string[];

  /**
   * Optional in-process provider delivery. Receives the resolved provider
   * (may be null) and its type; returns whether it consumed the response.
   * Runs inside a guarded try/catch so a provider throw never blocks the
   * MCP/DB stages.
   */
  deliverToProvider?: (provider: AIProvider | null, providerType: AIProviderType) => boolean;

  /** Per-waiter MCP channel builder. Omit for provider-only prompts. */
  mcpChannel?: (sessionId: string, waiterId: string) => string;
  /** Optional session-scoped fallback channel (only if no per-waiter listener fired). */
  fallbackChannel?: (sessionId: string) => string;
  /** Payload emitted on the IPC channels. Required when `mcpChannel` is set. */
  ipcPayload?: Record<string, unknown>;

  /**
   * Durable DB record content; omit to skip persistence. Stored with
   * source=providerType. Typed as `object` so callers can pass a purpose-built
   * record type (e.g. ToolPermissionResponseRecord) without an index signature.
   */
  dbRecord?: object;

  /** Renderer clear events. The driver always also calls tray `onPromptResolved`. */
  notify: () => void;
}

/**
 * Run the four independent delivery stages for one mobile prompt response.
 */
export async function deliverMobilePromptResponse(
  descriptor: MobilePromptDeliveryDescriptor,
): Promise<{
  responsePersisted: boolean;
  persistenceError: string | null;
  providerConsumed: boolean;
  notifiedWaiter: boolean;
  promptClear: PendingPromptPersistenceResult;
  staleAction: boolean;
}> {
  const { sessionId, promptType } = descriptor;
  // Capture arrival time before any asynchronous work. Pollers use createdAt
  // as their stale-response cutoff, so assigning it after an IPC waiter wakes
  // could make this response look like it belongs to a later prompt that
  // reuses the same raw provider id.
  const receivedAt = new Date();
  const claimed = await runClaimedPendingPromptAction(
    sessionId,
    descriptor.promptId,
    async ({ ownership }) => {
      const { providerType, provider } = await resolveSessionProvider(sessionId);

      // Durable response persistence and every consumer/UI side effect happen
      // only after the exact prompt id + generation was compare-claimed. The
      // shared prompt lock remains held until this callback returns, so B cannot
      // open between the claim and A's exact delivery.
      let responsePersisted = descriptor.dbRecord === undefined;
      let persistenceError: string | null = null;
      if (descriptor.dbRecord) {
        try {
          await AgentMessagesRepository.create({
            sessionId,
            source: providerType,
            direction: 'output',
            createdAt: receivedAt,
            content: JSON.stringify(descriptor.dbRecord),
          });
          responsePersisted = true;
        } catch (err) {
          persistenceError = err instanceof Error ? err.message : String(err);
          log.warn(`[Mobile] Failed to persist ${promptType} response: ${err}`);
        }
      }

      let providerConsumed = false;
      if (descriptor.deliverToProvider) {
        try {
          providerConsumed = descriptor.deliverToProvider(provider, providerType);
        } catch (err) {
          log.warn(`[Mobile] ${promptType} provider delivery threw: ${err}`);
        }
      }

      let notifiedWaiter = false;
      try {
        if (descriptor.mcpChannel && descriptor.ipcPayload) {
          for (const waiterId of descriptor.waiterIds ?? []) {
            const channel = descriptor.mcpChannel(sessionId, waiterId);
            if (ipcMain.listenerCount(channel) > 0) {
              notifiedWaiter = true;
              log.info(`[Mobile] Emitting ${promptType} on MCP channel: ${channel}`);
              ipcMain.emit(channel, {}, descriptor.ipcPayload);
            }
          }
          if (!notifiedWaiter && descriptor.fallbackChannel) {
            const fallback = descriptor.fallbackChannel(sessionId);
            if (ipcMain.listenerCount(fallback) > 0) {
              notifiedWaiter = true;
              log.info(`[Mobile] Emitting ${promptType} on fallback channel: ${fallback}`);
              ipcMain.emit(fallback, {}, descriptor.ipcPayload);
            }
          }
        }
      } catch (err) {
        log.warn(`[Mobile] ${promptType} IPC delivery threw: ${err}`);
      }

      log.info(
        `[Mobile] ${promptType} resolution: providerConsumed=${providerConsumed}, notifiedWaiter=${notifiedWaiter}`,
      );

      try {
        descriptor.notify();
      } catch (err) {
        log.warn(`[Mobile] ${promptType} renderer notification threw: ${err}`);
      }
      try {
        TrayManager.getInstance().onPromptResolved(sessionId);
      } catch (err) {
        log.warn(`[Mobile] ${promptType} tray notification threw: ${err}`);
      }
      try {
        await settleConfiguredInteractiveAttentionAfterResponse(
          (settleSessionId, eventIdentity, reason, options) =>
            attentionEventService.cancelInteractivePrompt(
              settleSessionId,
              eventIdentity,
              reason,
              options,
            ),
          {
            sessionId,
            eventIdentity: descriptor.promptId,
            attentionGeneration: ownership.attentionGeneration ?? undefined,
            respondedBy: 'mobile',
            cancelReason:
              (descriptor.ipcPayload as { cancelled?: boolean } | undefined)?.cancelled === true
                ? 'cancelled'
                : 'answered',
          },
          (notificationError) => {
            log.warn(
              '[Mobile] Native-winner notification attempt failed:',
              notificationError,
            );
          },
        );
      } catch (err) {
        log.warn(`[Mobile] ${promptType} attention settlement threw: ${err}`);
      }

      return { responsePersisted, persistenceError, providerConsumed, notifiedWaiter };
    },
  );

  if (!claimed.claimed || !claimed.value) {
    log.warn(
      `[Mobile] Ignoring stale ${promptType} action for ${sessionId}/${descriptor.promptId}`,
    );
    return {
      responsePersisted: false,
      persistenceError: null,
      providerConsumed: false,
      notifiedWaiter: false,
      promptClear: claimed.promptClear,
      staleAction: true,
    };
  }

  return {
    ...claimed.value,
    promptClear: claimed.promptClear,
    staleAction: false,
  };
}
