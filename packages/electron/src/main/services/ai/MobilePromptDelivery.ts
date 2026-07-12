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
): Promise<void> {
  const { sessionId, promptType } = descriptor;
  // Capture arrival time before any asynchronous work. Pollers use createdAt
  // as their stale-response cutoff, so assigning it after an IPC waiter wakes
  // could make this response look like it belongs to a later prompt that
  // reuses the same raw provider id.
  const receivedAt = new Date();
  const { providerType, provider } = await resolveSessionProvider(sessionId);

  // Stage 1 — durable DB record. Persist before waking any consumer so a
  // resumed provider/waiter cannot register a later same-id prompt before this
  // response is durable. Failure remains best-effort and does not gate the
  // provider or IPC paths.
  if (descriptor.dbRecord) {
    try {
      await AgentMessagesRepository.create({
        sessionId,
        source: providerType,
        direction: 'output',
        createdAt: receivedAt,
        content: JSON.stringify(descriptor.dbRecord),
      });
    } catch (err) {
      log.warn(`[Mobile] Failed to persist ${promptType} response: ${err}`);
    }
  }

  // Stage 2 — in-process provider (guarded; never gates the rest).
  let providerConsumed = false;
  if (descriptor.deliverToProvider) {
    try {
      providerConsumed = descriptor.deliverToProvider(provider, providerType);
    } catch (err) {
      log.warn(`[Mobile] ${promptType} provider delivery threw: ${err}`);
    }
  }

  // Stage 3 — MCP/IPC waiter, independent of the provider path.
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

  // Stage 4 — renderer clear + tray. Keep these independent as well: a stale
  // BrowserWindow must not prevent the tray prompt count from being cleared.
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
}
