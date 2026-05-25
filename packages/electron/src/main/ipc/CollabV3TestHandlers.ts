/**
 * CollabV3TestHandlers
 *
 * Test-only IPC handlers that reproduce the CollabV3 JWT-mismatch hang
 * described in the May 21 2026 investigation: when the personal Stytch
 * JWT's `sub` doesn't match the configured sync userId, every agent
 * message triggered `MessageSyncHandler.onMessageCreated -> connect()`
 * which threw AUTH_MISMATCH and logged `[MessageSyncHandler] Failed to
 * connect session ...`. In the field this drove ~5-10 connect
 * attempts/sec/session and flooded main.log (1686 / 4986 lines in the
 * affected window).
 *
 * Gated on `process.env.PLAYWRIGHT === '1'` (mirroring
 * `tracker-sync:connect-test` and `document-sync:open-test`).
 *
 * Companion spec: packages/electron/e2e/sync/collabv3-jwt-mismatch-hang.spec.ts
 */

import * as syncModule from '@nimbalyst/runtime/sync';
import type {
  SyncProvider,
  SyncConfig,
} from '@nimbalyst/runtime/sync';
import type { AgentMessage } from '@nimbalyst/runtime';
import { safeHandle } from '../utils/ipcRegistry';

interface ReproState {
  provider: SyncProvider;
  messageSyncHandler: ReturnType<typeof syncModule.createMessageSyncHandler>;
  connectAttempts: number;
  authMismatchThrows: number;
  syncFailureLogs: number;
  startedAt: number;
  originalConsoleError: typeof console.error;
}

let state: ReproState | null = null;

/**
 * Builds an unsigned JWT (alg=none) with the given claims. The CollabV3
 * client's `decodeJwtClaims` only base64-decodes the payload, so an unsigned
 * JWT is sufficient to drive the AUTH_MISMATCH branch.
 */
function makeUnsignedJwt(claims: Record<string, unknown>): string {
  const b64url = (obj: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(obj), 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  const header = b64url({ alg: 'none', typ: 'JWT' });
  const payload = b64url(claims);
  return `${header}.${payload}.`;
}

function teardown(): void {
  if (!state) return;
  try {
    state.provider.disconnectAll();
  } catch {
    /* ignore */
  }
  console.error = state.originalConsoleError;
  state = null;
}

export function registerCollabV3TestHandlers(): void {
  if (process.env.PLAYWRIGHT !== '1') {
    return;
  }

  safeHandle('collabv3:hang-repro:init', async () => {
    try {
      // Reset any prior repro state in this process so a re-run starts clean.
      teardown();

      const configUserId = 'user-A-personal';
      const jwtSub = 'user-B-team'; // mismatched on purpose

      const config: SyncConfig = {
        // Loopback URL never used: createCollabV3Sync eagerly calls
        // connectToIndex() at construction, ensureFreshJwt() detects the
        // mismatch and sets indexAuthBlocked before any WebSocket opens.
        serverUrl: 'ws://127.0.0.1:0',
        getJwt: async () =>
          makeUnsignedJwt({
            sub: jwtSub,
            organization_id: 'org-team',
            exp: Math.floor(Date.now() / 1000) + 300,
          }),
        orgId: 'org-personal',
        userId: configUserId,
      };

      const realProvider = syncModule.createCollabV3Sync(config);

      // Wrap connect() so we can count how many times it's invoked and
      // observe the AUTH_MISMATCH throw rate at the per-session entry
      // point exercised by MessageSyncHandler.onMessageCreated.
      const wrappedConnect = realProvider.connect.bind(realProvider);
      const provider: SyncProvider = new Proxy(realProvider, {
        get(target, prop, receiver) {
          if (prop === 'connect') {
            return async (sessionId: string) => {
              if (state) state.connectAttempts += 1;
              try {
                await wrappedConnect(sessionId);
              } catch (err) {
                if (state && (err as any)?.code === 'AUTH_MISMATCH') {
                  state.authMismatchThrows += 1;
                }
                throw err;
              }
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });

      const messageSyncHandler = syncModule.createMessageSyncHandler(provider);

      // Spy on console.error to count flooded log lines, faithful to the
      // bug we observed in main.1.log (`[MessageSyncHandler] Failed to
      // connect session ...`).
      const originalConsoleError = console.error;
      console.error = (...args: unknown[]) => {
        const first = args[0];
        if (
          typeof first === 'string' &&
          first.includes('[MessageSyncHandler] Failed to connect session')
        ) {
          if (state) state.syncFailureLogs += 1;
          // Don't forward -- keep test output clean.
          return;
        }
        originalConsoleError(...args);
      };

      state = {
        provider,
        messageSyncHandler,
        connectAttempts: 0,
        authMismatchThrows: 0,
        syncFailureLogs: 0,
        startedAt: Date.now(),
        originalConsoleError,
      };

      // createCollabV3Sync fires connectToIndex() asynchronously at
      // construction; let that microtask settle so indexAuthBlocked is
      // observable to callers before the test pumps messages.
      await new Promise((resolve) => setTimeout(resolve, 50));

      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  safeHandle(
    'collabv3:hang-repro:fire-message',
    async (_event, payload: { sessionId: string; messageId: string }) => {
      if (!state) {
        return { success: false, error: 'repro not initialized' };
      }
      const fakeMessage: AgentMessage = {
        sessionId: payload?.sessionId ?? 'sess-hang-repro',
        source: 'claude-code',
        direction: 'output',
        content: 'irrelevant for repro',
        providerMessageId:
          payload?.messageId ?? `msg-${Date.now()}-${Math.random()}`,
      };

      // Mirror production: `MessageSyncHandler.onMessageCreated` swallows
      // its own errors via the inner try/catch (SyncedSessionStore.ts:283).
      // We just call it and let the wrapped provider count.
      await state.messageSyncHandler.onMessageCreated(fakeMessage);
      return { success: true };
    },
  );

  safeHandle('collabv3:hang-repro:get-stats', async () => {
    if (!state) {
      return { success: false, error: 'repro not initialized' };
    }
    return {
      success: true,
      stats: {
        connectAttempts: state.connectAttempts,
        authMismatchThrows: state.authMismatchThrows,
        syncFailureLogs: state.syncFailureLogs,
        // The provider's own latch state, observable for the test's
        // sanity guard. After construction connectToIndex() has settled,
        // a JWT/userId mismatch flips this to true even though no
        // connect() call landed.
        providerIsAuthMismatched:
          state.provider.isAuthMismatched?.() ?? null,
        elapsedMs: Date.now() - state.startedAt,
      },
    };
  });

  safeHandle('collabv3:hang-repro:teardown', async () => {
    teardown();
    return { success: true };
  });
}
