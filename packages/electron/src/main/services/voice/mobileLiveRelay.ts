/** Versioned envelope inside the existing encrypted personal voice-tool relay. */
export interface MobileLiveScope {
  version: 1;
  hostDeviceId: string;
  projectId: string;
  sessionId?: string | null;
  voiceGeneration: string;
  actionId: string;
  announcingDeviceId: string;
}
export interface MobileLiveRequest {
  scope: MobileLiveScope;
  tool: string;
  arguments: string;
}
export interface MobileLiveResult { success: boolean; result?: string; error?: string }

export function decodeMobileLiveRequest(json: string, projectId: string, localHost: string | undefined): MobileLiveRequest | null {
  try {
    const value = JSON.parse(json);
    const scope = value?.scope;
    if (!scope || scope.version !== 1 || !localHost || scope.hostDeviceId !== localHost || scope.projectId !== projectId) return null;
    if (![scope.voiceGeneration, scope.actionId, scope.announcingDeviceId, value.tool, value.arguments].every(v => typeof v === 'string' && v.length > 0)) return null;
    if (scope.sessionId != null && (typeof scope.sessionId !== 'string' || !scope.sessionId)) return null;
    const args = JSON.parse(value.arguments);
    if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
    if (args.session_id !== undefined && args.session_id !== scope.sessionId) return null;
    return value as MobileLiveRequest;
  } catch { return null; }
}

/** Persist reservations before dispatch: a lost reply must never replay a mutation. */
export class MobileLiveActions {
  constructor(private readonly read: (id: string) => boolean, private readonly reserve: (id: string) => void) {}
  async run(request: MobileLiveRequest, execute: () => Promise<MobileLiveResult>): Promise<MobileLiveResult> {
    const key = JSON.stringify([request.scope.hostDeviceId, request.scope.projectId, request.scope.actionId]);
    if (this.read(key)) return { success: false, error: 'This voice action was already dispatched; inspect its existing result before retrying.' };
    this.reserve(key);
    return execute();
  }
}
