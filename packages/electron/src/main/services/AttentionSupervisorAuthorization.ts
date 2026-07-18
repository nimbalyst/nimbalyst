import { AISessionsRepository } from '@nimbalyst/runtime';
import type { WindowState } from '../types';
import { windowBindsWorkspace } from '../extensions/permissionPromptTargeting';

export const ATTENTION_SUPERVISOR_METADATA_KEY = 'authorizedAttentionSupervisorSessionIds';
const MAX_AUTHORIZED_ATTENTION_SUPERVISORS = 16;
const MAX_SESSION_ID_LENGTH = 200;

const targetLockTails = new Map<string, Promise<void>>();

/**
 * Reject attempts to smuggle the target-owned supervisor capability through a
 * generic metadata patch. The key is reserved at every depth because several
 * legacy IPC routes accept either `{key: value}` or `{metadata: {key: value}}`
 * and shallow-merging one shape can make the other shape canonical later.
 * Presence is sufficient: null/undefined/empty-array replacement attempts are
 * mutations too. The dedicated, confirmed authorization service intentionally
 * does not call this guard.
 */
export function assertNoReservedAttentionSupervisorMetadataMutation(
  candidate: unknown,
  route: string,
): void {
  const seen = new WeakSet<object>();
  const containsReservedKey = (value: unknown): boolean => {
    if (!value || typeof value !== 'object') return false;
    if (seen.has(value)) return false;
    seen.add(value);
    if (Object.prototype.hasOwnProperty.call(value, ATTENTION_SUPERVISOR_METADATA_KEY)) {
      return true;
    }
    for (const nested of Object.values(value)) {
      if (containsReservedKey(nested)) return true;
    }
    return false;
  };

  if (containsReservedKey(candidate)) {
    const boundedRoute = typeof route === 'string' && route.trim()
      ? route.trim().slice(0, 200)
      : 'generic metadata route';
    throw new Error(
      `${ATTENTION_SUPERVISOR_METADATA_KEY} is reserved and cannot be changed through ${boundedRoute}; ` +
      'use the dedicated user-confirmed attention supervisor authorization route',
    );
  }
}

export interface SetAttentionSupervisorAuthorizationArgs {
  workspacePath: string;
  targetSessionId: string;
  supervisorSessionId: string;
  authorized: boolean;
}

export interface AttentionSupervisorUserConfirmationRequest {
  action: 'authorize' | 'revoke';
  targetSessionId: string;
  supervisorSessionId: string;
}

/**
 * Require a fresh affirmative user decision before the renderer-only mutation
 * route can change target-owned supervisor authority. Workspace/window binding
 * is checked separately by the IPC boundary; this guard prevents a bound but
 * unrelated renderer invocation from silently conferring authority.
 */
export async function requireAttentionSupervisorUserConfirmation(
  args: Pick<
    SetAttentionSupervisorAuthorizationArgs,
    'targetSessionId' | 'supervisorSessionId' | 'authorized'
  >,
  confirm: (request: AttentionSupervisorUserConfirmationRequest) => Promise<boolean>,
): Promise<void> {
  const targetSessionId = requireBoundedString(args.targetSessionId, 'targetSessionId');
  const supervisorSessionId = requireBoundedString(args.supervisorSessionId, 'supervisorSessionId');
  if (typeof args.authorized !== 'boolean') {
    throw new Error('authorized must be a boolean');
  }
  const confirmed = await confirm({
    action: args.authorized ? 'authorize' : 'revoke',
    targetSessionId,
    supervisorSessionId,
  });
  if (!confirmed) {
    throw new Error('Attention supervisor change was not confirmed by the user');
  }
}

export function assertBoundWindowCanMutateAttentionSupervisors(
  senderState: WindowState | undefined,
  workspacePath: string,
): void {
  if (!windowBindsWorkspace(senderState, workspacePath)) {
    throw new Error('Calling window is not authorized for this workspace');
  }
}

function requireBoundedString(value: unknown, field: string, maxLength = MAX_SESSION_ID_LENGTH): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} is required`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new Error(`${field} must be at most ${maxLength} characters`);
  }
  return normalized;
}

function readMetadata(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function readAuthorizedAttentionSupervisorSessionIds(metadata: unknown): string[] {
  const value = readMetadata(metadata)[ATTENTION_SUPERVISOR_METADATA_KEY];
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  for (const candidate of value) {
    if (typeof candidate !== 'string') continue;
    const id = candidate.trim();
    if (!id || id.length > MAX_SESSION_ID_LENGTH || ids.includes(id)) continue;
    ids.push(id);
    if (ids.length >= MAX_AUTHORIZED_ATTENTION_SUPERVISORS) break;
  }
  return ids;
}

export function isAuthorizedAttentionSupervisor(
  targetMetadata: unknown,
  callerSessionId: string,
): boolean {
  return readAuthorizedAttentionSupervisorSessionIds(targetMetadata)
    .includes(callerSessionId);
}

async function withTargetLock<T>(targetSessionId: string, fn: () => Promise<T>): Promise<T> {
  const previousTail = targetLockTails.get(targetSessionId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const nextTail = previousTail.then(() => current);
  targetLockTails.set(targetSessionId, nextTail);
  await previousTail;
  try {
    return await fn();
  } finally {
    release();
    if (targetLockTails.get(targetSessionId) === nextTail) {
      targetLockTails.delete(targetSessionId);
    }
  }
}

/**
 * Persist one explicit target -> supervisor capability. This function is
 * intentionally not exposed through MCP; the renderer-only IPC route performs
 * the user/window authorization check before calling it.
 */
export async function setAttentionSupervisorAuthorization(
  args: SetAttentionSupervisorAuthorizationArgs,
): Promise<{
  targetSessionId: string;
  supervisorSessionId: string;
  authorized: boolean;
  authorizedSupervisorSessionIds: string[];
}> {
  const workspacePath = requireBoundedString(args.workspacePath, 'workspacePath', 4_000);
  const targetSessionId = requireBoundedString(args.targetSessionId, 'targetSessionId');
  const supervisorSessionId = requireBoundedString(args.supervisorSessionId, 'supervisorSessionId');
  if (typeof args.authorized !== 'boolean') {
    throw new Error('authorized must be a boolean');
  }
  if (args.authorized && targetSessionId === supervisorSessionId) {
    throw new Error('A session cannot supervise itself');
  }

  return withTargetLock(targetSessionId, async () => {
    const target = await AISessionsRepository.get(targetSessionId);
    if (!target || target.workspacePath !== workspacePath) {
      throw new Error(`Target session ${targetSessionId} not found`);
    }
    if (args.authorized) {
      const supervisor = await AISessionsRepository.get(supervisorSessionId);
      if (!supervisor || supervisor.workspacePath !== workspacePath) {
        throw new Error(`Supervisor session ${supervisorSessionId} not found`);
      }
    }

    const current = readAuthorizedAttentionSupervisorSessionIds(target.metadata);
    const next = args.authorized
      ? current.includes(supervisorSessionId)
        ? current
        : [...current, supervisorSessionId]
      : current.filter((id) => id !== supervisorSessionId);
    if (next.length > MAX_AUTHORIZED_ATTENTION_SUPERVISORS) {
      throw new Error(
        `A session may authorize at most ${MAX_AUTHORIZED_ATTENTION_SUPERVISORS} attention supervisors`,
      );
    }
    if (next.length !== current.length || next.some((id, index) => id !== current[index])) {
      await AISessionsRepository.updateMetadata(targetSessionId, {
        metadata: { [ATTENTION_SUPERVISOR_METADATA_KEY]: next },
      });
    }

    return {
      targetSessionId,
      supervisorSessionId,
      authorized: next.includes(supervisorSessionId),
      authorizedSupervisorSessionIds: next,
    };
  });
}

/**
 * The sole product mutation orchestration: no canonical metadata write occurs
 * until the caller supplies an affirmative user decision for this exact
 * target/supervisor/action tuple.
 */
export async function setAttentionSupervisorAuthorizationWithUserConfirmation(
  args: SetAttentionSupervisorAuthorizationArgs,
  confirm: (request: AttentionSupervisorUserConfirmationRequest) => Promise<boolean>,
): Promise<Awaited<ReturnType<typeof setAttentionSupervisorAuthorization>>> {
  await requireAttentionSupervisorUserConfirmation(args, confirm);
  return setAttentionSupervisorAuthorization(args);
}
