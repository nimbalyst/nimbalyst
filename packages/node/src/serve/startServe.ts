import { readWorkspaceContext, expandRemoteCommand } from './workspaceContext.js';
import { stageRemoteAttachments } from './remoteAttachments.js';
/**
 * Wire the real thing: credentials, sockets, stores, git, the turn runner.
 *
 * `serveRuntime.ts` holds every decision; this file holds every dependency. The
 * split is deliberate -- everything below is untestable without a network, and
 * anything untestable that also makes a decision is a decision that ships
 * unverified.
 *
 * Ordering that matters:
 *
 *  1. The credential is refreshed BEFORE the socket opens. Opening first and
 *     discovering the credential is revoked costs a connection the server has
 *     to reject and buries the real cause under a WebSocket error.
 *  2. Both stores are decorated at `NimbalystNode.open`, not after. The
 *     repositories are module-level singletons; a write that lands between
 *     `open()` and a later `setStore` is persisted locally and never synced.
 *  3. `deviceAnnounce` is not sent from here. CollabV3Sync announces on open
 *     and re-announces every 30s from `getDeviceInfo`, which is why that is a
 *     callback and not a fixed object.
 */

import { createRequire } from 'node:module';

import { createCollabV3Sync } from '@nimbalyst/runtime/sync/CollabV3Sync';
import {
  createMessageSyncHandler,
  createSyncedSessionStore,
} from '@nimbalyst/runtime/sync/SyncedSessionStore';
import {
  deriveEncryptionKey,
  personalSyncEncryptionSalt,
} from '@nimbalyst/runtime/sync/encryptionKey';
import { setSyncClientInfo } from '@nimbalyst/runtime/sync/syncClientInfo';
import { nodeAccessTokenAsPersonalJwt } from '@nimbalyst/runtime/sync/nodeCredentialToken';
import type { SyncConfig, SyncProvider } from '@nimbalyst/runtime/sync/types';
import { AgentMessagesRepository } from '@nimbalyst/runtime/storage/repositories/AgentMessagesRepository';
import type {
  AIProviderType,
  AgentRole,
  SessionType,
} from '@nimbalyst/runtime/ai/server/types';

import { NimbalystNode } from '../NimbalystNode.js';
import { requireSyncSettings, type LoadedConfig } from '../config.js';
import {
  CredentialRevokedError,
  createCredentialRefresher,
} from './credentials.js';
import { createHeadlessDeviceInfo } from './deviceIdentity.js';
import { ensureIndexSynced } from './indexEligibility.js';
import { createRefreshLoop, shutdownServe } from './lifecycle.js';
import { createStderrLogger, type Logger } from './log.js';
import { createQueuedPromptStore } from './queuedPrompts.js';
import { DEFAULT_CHECKOUT_ROOT, confineCheckout, ensureCheckout } from './repoCheckout.js';
import { createServeRuntime } from './serveRuntime.js';
import {
  createSyncedAgentMessagesStore,
  type FlushableAgentMessagesStore,
} from './syncedAgentMessagesStore.js';
import { withHostAttribution } from './hostAttributionStore.js';
import { loadWorkspaces } from './workspaces.js';

const require = createRequire(import.meta.url);

/**
 * The branded personal-member-id type, reached through `SyncConfig`.
 *
 * `asPersonalMemberId` lives in `@nimbalyst/runtime/auth/jwtScopes`, which has
 * no `node` export condition -- its exports entry points at `dist/`, which a
 * Node consumer never builds, so importing it from here does not typecheck even
 * though the module IS emitted into `dist-node/`. Deriving the type off
 * `SyncConfig` keeps the brand (a team member id still cannot be passed where
 * this is required) without the unresolvable import. Reported to the runtime
 * slice; delete this the day that export gains its condition.
 */
type PersonalMemberId = SyncConfig['personalMemberId'];

/** How often to re-establish `synced` on a socket this process did not reopen. */
const ELIGIBILITY_HEARTBEAT_MS = 5 * 60 * 1000;

export interface ServeOptions {
  config: LoadedConfig;
  log?: Logger;
  /** Resolves when the process should shut down (SIGTERM). */
  signal?: AbortSignal;
}

export interface ServeResult {
  /** 0 on a clean shutdown, 3 when the credential was revoked. */
  exitCode: number;
}

function packageVersion(): string {
  try {
    return (require('../../package.json') as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export async function serve(options: ServeOptions): Promise<ServeResult> {
  const log = options.log ?? createStderrLogger();
  const config = options.config;
  const sync = requireSyncSettings(config);

  if (!config.resolvedWorkspacesPath) {
    throw new Error('[nimbalyst-node] "workspacesPath" is required to run "serve"');
  }
  const workspacesPath = config.resolvedWorkspacesPath;
  const checkoutRoot = config.checkoutRoot ?? DEFAULT_CHECKOUT_ROOT;

  setSyncClientInfo({ platform: 'headless', version: packageVersion() });

  const credentials = createCredentialRefresher({
    serverUrl: sync.serverUrl,
    credentialPath: sync.credentialPath,
    log,
  });

  // Fail before opening anything: a revoked credential is terminal and the
  // operator needs the reason, not a socket error.
  try {
    await credentials.getAccessToken();
  } catch (error) {
    if (error instanceof CredentialRevokedError) {
      log('credential-revoked', { reason: error.reason });
      return { exitCode: 3 };
    }
    throw error;
  }
  log('credential-ready', { nodeId: credentials.nodeId(), serverUrl: sync.serverUrl });

  // The boundary where a raw string becomes a branded personal member id: the
  // desktop wrote `sync.personalUserId` into the config after resolving the
  // user's PERSONAL org membership. A team member id here would derive a
  // different key and silently orphan every encrypted row.
  const personalMemberId = sync.personalUserId as PersonalMemberId;
  const encryptionKey = await deriveEncryptionKey(
    sync.encryptionKeySeed,
    // The PERSONAL member id, never a team one: the salt is what makes this
    // node's key bit-identical to the desktop's and the phone's.
    personalSyncEncryptionSalt(personalMemberId),
  );

  const getDeviceInfo = createHeadlessDeviceInfo(sync, { appVersion: packageVersion() });

  // Shutdown state is established BEFORE the provider, because
  // `createCollabV3Sync` starts connecting immediately and its first `getJwt`
  // can land before the rest of this function has run. A `const` timer declared
  // further down would still be in its temporal dead zone at that point.
  const timers: Array<ReturnType<typeof setInterval>> = [];
  let refreshLoop: ReturnType<typeof createRefreshLoop> | undefined;
  let exitCode = 0;
  let stopping = false;
  let resolveStopped: () => void;
  const stopped = new Promise<void>((resolve) => { resolveStopped = resolve; });

  function shutdown(): void {
    if (stopping) return;
    stopping = true;
    for (const timer of timers) clearInterval(timer);
    refreshLoop?.stop();
    resolveStopped();
  }

  /**
   * A 400 from the refresh endpoint is terminal, and CollabV3Sync swallows every
   * `getJwt` failure into its reconnect-with-backoff loop. Without this latch a
   * revocation looks exactly like a flapping network and the process spins until
   * the next proactive refresh notices, up to twelve minutes later.
   */
  function stopWithRevokedCredential(reason: string): void {
    if (stopping) return;
    log('credential-revoked', { reason });
    exitCode = 3;
    shutdown();
  }

  /**
   * The index socket's identity.
   *
   * Read straight from the provider, which bumps its counter on every index
   * disconnect. An earlier version sampled `isIndexReady()` and inferred a
   * change from the transition -- which cannot see a disconnect and reconnect
   * that both complete between two samples, exactly the case the twelve-minute
   * rotation produces. The server is the final authority either way: it rejects
   * a response from a socket that does not hold the claim.
   */
  function connectionGeneration(): number {
    return syncProvider?.getConnectionGeneration?.() ?? 0;
  }

  const syncProvider: SyncProvider = createCollabV3Sync({
    serverUrl: sync.serverUrl,
    orgId: sync.personalOrgId,
    personalMemberId,
    getJwt: async () => {
      try {
        return nodeAccessTokenAsPersonalJwt(await credentials.getAccessToken());
      } catch (error) {
        if (error instanceof CredentialRevokedError) stopWithRevokedCredential(error.reason);
        throw error;
      }
    },
    encryptionKey,
    getDeviceInfo,
  });

  const messageSync = createMessageSyncHandler(syncProvider);
  let transcripts: FlushableAgentMessagesStore | undefined;

  const node = await NimbalystNode.open(config, {
    // Outermost, so `hostDeviceId` is in the payload the synced store publishes
    // from -- not stamped afterwards, where a failure leaves the session
    // permanently unattributed. See hostAttributionStore.ts.
    decorateSessionStore: (store) =>
      withHostAttribution(createSyncedSessionStore(store, syncProvider), sync.deviceId),
    decorateAgentMessagesStore: (store) => {
      transcripts = createSyncedAgentMessagesStore(store, messageSync, log);
      return transcripts;
    },
  });

  const queue = createQueuedPromptStore(node.database);

  const runtime = createServeRuntime({
    deviceId: sync.deviceId,
    sync: syncProvider,
    log,
    queue,
    loadWorkspaces: () => loadWorkspaces(workspacesPath),
    ensureCheckout: (mapping) => ensureCheckout(mapping, { checkoutRoot }),
    confineCheckout: (mapping) => confineCheckout(mapping, { checkoutRoot }),
    connectionGeneration,
    flushTranscripts: (timeoutMs) => transcripts?.flushPending(timeoutMs) ?? Promise.resolve(0),

    noteFailed: async (sessionId, prompt, error) => {
      await AgentMessagesRepository.create({
        sessionId, source: 'system', direction: 'output',
        content: JSON.stringify({type: 'system', text: `The remote turn could not start: ${error}. Correct the problem and send the prompt again.`, prompt: prompt.slice(0, 500)}),
        messageKind: 'system', createdAt: new Date(), searchable: false,
      });
    },

    noteInterrupted: async (sessionId, prompt) => {
      // Written through the decorated store, so it reaches the session room the
      // same way any other transcript row does. Without it the requester sees a
      // prompt that simply stopped, with nothing saying why.
      await AgentMessagesRepository.create({
        sessionId,
        source: 'system',
        direction: 'output',
        content: JSON.stringify({
          type: 'system',
          text: 'This prompt was interrupted when the remote node stopped, and was not re-run. '
            + 'Send it again if you still want it.',
          prompt: prompt.slice(0, 500),
        }),
        messageKind: 'system',
        createdAt: new Date(),
        searchable: false,
      });
    },

    createSession: async (input) => {
      const session = await node.sessionManager.createSession(
        input.provider as AIProviderType,
        undefined,
        // The REQUESTER's workspace path, so the index entry files this session
        // under the project the user actually has open.
        input.projectId,
        undefined,
        input.model,
        (input.sessionType ?? 'session') as SessionType,
        'agent',
        undefined,
        undefined,
        undefined,
        (input.agentRole ?? 'standard') as AgentRole,
      );

      // Host attribution, through the synced store so it reaches the index.
      // Bookkeeping past the point of no return: the session exists either way,
      // so a failure here is logged, not surfaced as "creation failed".
      try {
        await node.store.updateMetadata(session.id, {
          ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
          metadata: { hostDeviceId: input.hostDeviceId },
        });
      } catch (error) {
        log('host-attribution-failed', {
          sessionId: session.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      // Publish a complete index entry, the way the desktop does after creating
      // a session for a remote request. `syncSessionsToIndex` builds a FRESH
      // entry from this payload, so every field the requester needs on first
      // sight has to be present here -- `parentSessionId` and `hostDeviceId`
      // included, or the write above is clobbered by this one.
      syncProvider.syncSessionsToIndex?.([{
        id: session.id,
        title: session.title ?? 'Untitled',
        provider: session.provider,
        model: session.model,
        mode: session.mode,
        sessionType: session.sessionType,
        agentRole: session.agentRole,
        parentSessionId: input.parentSessionId ?? session.parentSessionId ?? undefined,
        hostDeviceId: input.hostDeviceId,
        createdBySessionId: session.createdBySessionId ?? undefined,
        // Both are the REQUESTER's path. This is what groups the session under
        // their project instead of under this node's checkout directory.
        workspaceId: input.projectId,
        workspacePath: input.projectId,
        messageCount: 0,
        updatedAt: session.updatedAt,
        createdAt: session.createdAt,
      }]);

      return { id: session.id };
    },

    getSessionProjectId: async (sessionId) => {
      const session = await node.store.get(sessionId);
      return session?.workspacePath ?? null;
    },

    workspaceContext: async workspace => {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encrypted = await crypto.subtle.encrypt({name: 'AES-GCM', iv}, encryptionKey, new TextEncoder().encode(JSON.stringify(await readWorkspaceContext(workspace))));
      return {encrypted: Buffer.from(encrypted).toString('base64'), iv: Buffer.from(iv).toString('base64')};
    },
    runTurn: async (input) => {
      const staged = await stageRemoteAttachments(input.attachments, encryptionKey);
      try {
      const result = await node.runTurn({
        sessionId: input.sessionId,
        workspacePath: input.workspacePath,
        prompt: await expandRemoteCommand(input.prompt, input.workspacePath),
        attachments: staged.attachments,
        options: input.options,
        onTurnStarted: input.onTurnStarted,
      });
      return { error: result.error };
      } finally { await staged.dispose(); }
    },
  });

  // Kept so shutdown can stop intake at the source rather than relying on a
  // flag every handler has to remember to check.
  const unsubscribes: Array<() => void> = [];

  unsubscribes.push(
    // Every reconnect, not just the ones this process initiates. A transcript
    // row that could not be sent is retried when a socket is usable again --
    // hooking only the twelve-minute rotation left a row stranded for up to
    // twelve minutes after a blip that lasted seconds.
    syncProvider.onConnectionGenerationChange?.((generation) => {
      void (async () => {
        if (!transcripts || transcripts.failedCount() === 0) return;
        const stillFailed = await transcripts.retryFailed();
        log('transcript-retried', { generation, stillFailed });
      })();
    }) ?? (() => {}),
    syncProvider.onCreateSessionRequest?.((request) => {
      void runtime.handleCreateSessionRequest(request);
    }) ?? (() => {}),
    syncProvider.onIndexChange?.((sessionId, entry) => {
      void runtime.handleIndexChange(sessionId, entry);
    }) ?? (() => {}),
    syncProvider.onSessionControlMessage?.((message) => {
      void runtime.handleSessionControlMessage(message);
    }) ?? (() => {}),
  );

  // Work the previous process did not finish. A broadcast can already be
  // arriving by now, which is fine: drains are serialized per session and the
  // claim is an atomic status transition, so a recovered prompt and a fresh one
  // queue behind each other rather than racing.
  await runtime.recoverPersistedQueue();

  log('connected', { deviceId: sync.deviceId, serverUrl: sync.serverUrl });

  // Announced is not the same as eligible: the server also requires this socket
  // to be `synced`, which only an index read produces. See indexEligibility.ts.
  await ensureIndexSynced({ provider: syncProvider, log });
  log('announced', { deviceId: sync.deviceId, deviceType: 'headless' });

  log('serving', {
    deviceId: sync.deviceId,
    serverUrl: sync.serverUrl,
    workspaces: workspacesPath,
  });

  // `synced` is per-socket server state, so a reconnect this node did not
  // initiate (server hibernation, network blip) silently drops it back out of
  // host selection. Re-establish it on a slow heartbeat; on protocol v2 this is
  // a delta read, not a bootstrap.
  const eligibilityTimer = setInterval(() => {
    void ensureIndexSynced({ provider: syncProvider, log });
  }, ELIGIBILITY_HEARTBEAT_MS);
  eligibilityTimer.unref?.();
  timers.push(eligibilityTimer);

  // Rotation, and the retry policy for a rotation that could not happen. A 400
  // is terminal and stops the loop for good; a network error backs off and tries
  // again well inside the token's remaining life. See lifecycle.ts.
  refreshLoop = createRefreshLoop({
    log,
    onRevoked: stopWithRevokedCredential,
    rotate: async () => {
      await credentials.refresh();
      // A live socket still carries the retired token. Force a fresh one now,
      // on our schedule, rather than letting the server close it at 4003.
      await syncProvider.reconnectIndex?.();
      // The socket that held any outstanding create-session claim is gone; the
      // provider's own generation counter has already moved.
      log('reconnected', { deviceId: sync.deviceId, generation: connectionGeneration() });
      // A new socket starts un-synced; without this the node stays connected
      // and announced but stops being offered work.
      await ensureIndexSynced({ provider: syncProvider, log });
    },
  });
  // Not if shutdown already ran: `stopWithRevokedCredential` can fire from the
  // provider's very first `getJwt`, before this line, and starting a rotation
  // loop against a credential we already know is gone is pointless work.
  if (!stopping) refreshLoop.start();

  options.signal?.addEventListener('abort', shutdown, { once: true });
  if (options.signal?.aborted) shutdown();

  await stopped;

  await shutdownServe({
    runtime,
    unsubscribes,
    revoked: exitCode === 3,
    log,
    disconnect: () => syncProvider.disconnectAll(),
  });

  node.close();
  log('stopped', { exitCode });
  return { exitCode };
}
