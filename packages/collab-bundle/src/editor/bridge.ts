import type { TextFormatType } from 'lexical';
import {
  asTeamJwt,
  asTeamMemberId,
  type TeamJwt,
} from '@nimbalyst/runtime/auth/jwtScopes';

import { mountCollabEditor } from './mount';
import type {
  CollabEditorFlushResult,
  CollabEditorHandle,
  CollabEditorMountOptions,
  CollabEditorUser,
  CollabEditorTermination,
  CollabEditorWriteRejection,
  TeamDocumentId,
  TeamOrgId,
  TeamProjectId,
} from './types';

export interface BridgeMountRequest {
  source: {
    kind: 'team-room';
    serverUrl: string;
    room: {
      orgId: string;
      projectId: string;
      documentId: string;
    };
    auth: {
      scope: 'team';
      // identity-scope-allow: serialized WebView input is branded at the bridge boundary
      memberId: string;
      // identity-scope-allow: serialized WebView input is branded at the bridge boundary
      jwt: string;
    };
  };
  user: Omit<CollabEditorUser, 'memberId'>;
  readOnly?: boolean;
}

export interface BridgeAuthResponse {
  requestId: string;
  scope: 'team';
  // identity-scope-allow: serialized WebView response is branded by BridgeTeamJwtBroker
  jwt: string;
}

export interface BridgeFlushRequest {
  requestId: string;
  timeoutMs?: number;
}

export type EditorBridgeMessage =
  | { type: 'editorReady' }
  | { type: 'stateChanged'; state: ReturnType<CollabEditorHandle['getState']> }
  | { type: 'presenceChanged'; presence: ReturnType<CollabEditorHandle['getPresence']> }
  | { type: 'authRequested'; requestId: string; scope: 'team'; forceRefresh: boolean }
  | { type: 'writeRejected'; rejection: CollabEditorWriteRejection }
  | { type: 'terminated'; termination: CollabEditorTermination }
  | { type: 'flushCompleted'; requestId: string; result: CollabEditorFlushResult }
  | { type: 'error'; message: string; stack?: string };

export interface NimbalystEditorBridgeApi {
  mount(request: BridgeMountRequest): void;
  provideTeamJwt(response: BridgeAuthResponse): void;
  flush(request: BridgeFlushRequest): Promise<CollabEditorFlushResult>;
  setPresenceActive(active: boolean): void;
  setReadOnly(readOnly: boolean): void;
  markClean(): void;
  getContent(): string;
  focus(): void;
  insertText(text: string): void;
  formatText(format: TextFormatType): void;
  destroy(): void;
}

export interface InstallEditorBridgeOptions {
  element: HTMLElement;
  target?: Window & typeof globalThis;
  postMessage?: (message: EditorBridgeMessage) => void;
  mountEditor?: (options: CollabEditorMountOptions) => CollabEditorHandle;
}

class BridgeTeamJwtBroker {
  private nextRequestId = 1;
  private pending = new Map<string, (jwt: TeamJwt) => void>();

  constructor(
    private currentJwt: TeamJwt,
    private readonly postMessage: (message: EditorBridgeMessage) => void,
  ) {}

  getTeamJwt = (options?: { forceRefresh?: boolean }): Promise<TeamJwt> => {
    if (!options?.forceRefresh) return Promise.resolve(this.currentJwt);
    const requestId = `team-jwt-${this.nextRequestId++}`;
    const promise = new Promise<TeamJwt>((resolve) => {
      this.pending.set(requestId, resolve);
    });
    this.postMessage({
      type: 'authRequested',
      requestId,
      scope: 'team',
      forceRefresh: true,
    });
    return promise;
  };

  provide(response: BridgeAuthResponse): void {
    if (response.scope !== 'team') {
      throw new Error('The collaborative editor bridge accepts team-scoped JWTs only.');
    }
    const resolve = this.pending.get(response.requestId);
    if (!resolve) throw new Error(`Unknown team JWT request: ${response.requestId}`);
    this.pending.delete(response.requestId);
    this.currentJwt = asTeamJwt(response.jwt);
    resolve(this.currentJwt);
  }

  destroy(): void {
    this.pending.clear();
  }
}

function defaultPostMessage(
  target: Window & typeof globalThis,
  message: EditorBridgeMessage,
): void {
  const webkit = (target as typeof target & {
    webkit?: { messageHandlers?: { editorBridge?: { postMessage(value: unknown): void } } };
  }).webkit;
  webkit?.messageHandlers?.editorBridge?.postMessage(message);
}

/** Install the serializable WebView adapter over mountCollabEditor(). */
export function installCollabEditorBridge(
  options: InstallEditorBridgeOptions,
): () => void {
  const target = options.target ?? window;
  const postMessage = options.postMessage ?? ((message) => defaultPostMessage(target, message));
  const mountEditor = options.mountEditor ?? mountCollabEditor;
  let mounted: CollabEditorHandle | null = null;
  let authBroker: BridgeTeamJwtBroker | null = null;

  const reportError = (error: unknown): void => {
    const normalized = error instanceof Error ? error : new Error(String(error));
    postMessage({ type: 'error', message: normalized.message, stack: normalized.stack });
  };

  const api: NimbalystEditorBridgeApi = {
    mount(request) {
      try {
        if (request.source.kind !== 'team-room' || request.source.auth.scope !== 'team') {
          throw new Error('The collaborative editor bridge requires a team-room source and team JWT.');
        }
        mounted?.destroy();
        authBroker?.destroy();
        authBroker = new BridgeTeamJwtBroker(
          asTeamJwt(request.source.auth.jwt),
          postMessage,
        );
        mounted = mountEditor({
          element: options.element,
          source: {
            kind: 'team-room',
            serverUrl: request.source.serverUrl,
            room: {
              orgId: request.source.room.orgId as TeamOrgId,
              projectId: request.source.room.projectId as TeamProjectId,
              documentId: request.source.room.documentId as TeamDocumentId,
            },
            auth: {
              scope: 'team',
              memberId: asTeamMemberId(request.source.auth.memberId),
              getTeamJwt: authBroker.getTeamJwt,
            },
          },
          user: {
            ...request.user,
            memberId: asTeamMemberId(request.source.auth.memberId),
          },
          readOnly: request.readOnly,
          onReady: () => postMessage({ type: 'editorReady' }),
          onStateChange: (state) => postMessage({ type: 'stateChanged', state }),
          onPresenceChange: (presence) => postMessage({ type: 'presenceChanged', presence }),
          onWriteRejected: (rejection) => postMessage({ type: 'writeRejected', rejection }),
          onTermination: (termination) => postMessage({ type: 'terminated', termination }),
          onError: reportError,
        });
      } catch (error) {
        reportError(error);
      }
    },
    provideTeamJwt(response) {
      try {
        authBroker?.provide(response);
      } catch (error) {
        reportError(error);
      }
    },
    async flush(request) {
      let result: CollabEditorFlushResult;
      try {
        result = mounted
          ? await mounted.flush({ timeoutMs: request.timeoutMs })
          : { status: 'unavailable', reason: 'not-mounted' };
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        reportError(normalized);
        result = { status: 'failed', message: normalized.message };
      }
      postMessage({ type: 'flushCompleted', requestId: request.requestId, result });
      return result;
    },
    setPresenceActive: (active) => mounted?.setPresenceActive(active),
    setReadOnly: (readOnly) => mounted?.setReadOnly(readOnly),
    markClean: () => mounted?.markClean(),
    getContent: () => mounted?.getMarkdown() ?? '',
    focus: () => mounted?.focus(),
    insertText: (text) => mounted?.insertText(text),
    formatText: (format) => mounted?.formatText(format),
    destroy() {
      mounted?.destroy();
      mounted = null;
      authBroker?.destroy();
      authBroker = null;
    },
  };

  (target as typeof target & { nimbalystEditor?: NimbalystEditorBridgeApi }).nimbalystEditor = api;

  return () => {
    api.destroy();
    const bridgeTarget = target as typeof target & { nimbalystEditor?: NimbalystEditorBridgeApi };
    if (bridgeTarget.nimbalystEditor === api) delete bridgeTarget.nimbalystEditor;
  };
}
