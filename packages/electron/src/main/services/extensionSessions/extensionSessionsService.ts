/**
 * Host side of `ctx.services.sessions` for extension backend modules.
 *
 * Every op runs under a scope the HOST derives from the calling module's
 * runtime (its extension id and bound workspace). Nothing a module sends can
 * widen that scope: owner extension ids are stamped here, and every op that
 * names a session first proves the session is owned by the calling extension
 * in the calling workspace.
 *
 * This module also feeds owned-session settles (completed / error / waiting /
 * interrupted) to the owning module through an event sink the privileged host
 * registers, so it never imports the host (which imports this module).
 */
import { randomUUID } from 'crypto';
import type {
  CreateOwnedSessionOptions,
  CreateOwnedWorkstreamOptions,
  NotifyUserOptions,
  OwnedSessionResult,
  OwnedSessionSettleOutcome,
  OwnedSessionSettledEvent,
  OwnedSessionStatus,
  OwnedSessionStatusResult,
  OwnedSessionSummary,
  OwnedSessionUsage,
  OwnedUsageReport,
  SessionOwner,
} from '@nimbalyst/extension-sdk';
import type { PromptProvenance } from '@nimbalyst/runtime/ai/server/types';
import { ModelIdentifier } from '@nimbalyst/runtime/ai/server/types';
import { EFFORT_LEVELS, clampEffortLevel } from '@nimbalyst/runtime/ai/server/effortLevels';
import { providerAppliesSessionDirective } from '@nimbalyst/runtime/ai/server/agentCapabilities';
import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import { getSessionStateManager } from '@nimbalyst/runtime/ai/server/SessionStateManager';
import { database } from '../../database/PGLiteDatabaseWorker';
import { dispatchMetaAgentTool } from '../../mcp/metaAgentServer';
import { sameWorkspaceIdentity } from '../../utils/workspaceIdentity';
import { toMillis } from '../../utils/timestampUtils';
import { broadcastSessionCreated } from '../session/broadcastSessionCreated';
import {
  OWNER_METADATA_KEY,
  OWNER_METADATA_MERGE_SQL,
  SESSION_DIRECTIVE_KEY,
  SESSION_OWNER_KEY,
  readOwnerMetadata,
  readSessionOwner,
} from './sessionOwnership';

export interface ExtensionSessionScope {
  extensionId: string;
  workspacePath: string;
}

/** The slice of AIService this service drives. Injected at startup. */
export interface ExtensionSessionsQueue {
  queuePromptForSession(
    sessionId: string,
    prompt: string,
    attachments?: unknown[],
    documentContext?: { promptProvenance: PromptProvenance }
  ): Promise<{ id: string }>;
  triggerQueuedPromptProcessingForSession(
    sessionId: string,
    workspacePath: string,
    reason: 'meta-agent'
  ): Promise<boolean>;
}

/** Delivery target for owned-session settles. Registered by the privileged host. */
export interface OwnedSessionEventSink {
  /** False when no running module holds `ai-sessions`; the settle lookup is skipped. */
  hasListeners(): boolean;
  emit(extensionId: string, workspacePath: string, event: OwnedSessionSettledEvent): void;
}

let queue: ExtensionSessionsQueue | null = null;
let sink: OwnedSessionEventSink | null = null;
let unsubscribeSettles: (() => void) | null = null;

export function setOwnedSessionEventSink(next: OwnedSessionEventSink | null): void {
  sink = next;
}

/**
 * Wire the prompt queue and start feeding settles to owners. Idempotent;
 * called from MetaAgentService.start, which already owns the AIService handle.
 */
export function startExtensionSessionService(nextQueue: ExtensionSessionsQueue): void {
  queue = nextQueue;
  unsubscribeSettles?.();
  unsubscribeSettles = getSessionStateManager().subscribe((event) => {
    if (event.type === 'session:started' || event.type === 'session:streaming') {
      lastSettle.delete(event.sessionId);
      return;
    }
    const outcome = SETTLE_OUTCOMES[event.type as keyof typeof SETTLE_OUTCOMES];
    if (!outcome) return;
    // Decided synchronously, in event order, before any await: a failed queued
    // turn emits `session:error` and then the chain cleanup's endSession emits
    // `session:completed`. That completed describes the same failed turn, so it
    // is dropped until the session runs again. Repeats of one outcome collapse.
    const previous = lastSettle.get(event.sessionId);
    if (previous === outcome || (previous === 'error' && outcome === 'completed')) return;
    lastSettle.set(event.sessionId, outcome);
    void deliverSettle(event.sessionId, outcome);
  });
}

/** Last settle outcome per session since it last started running. Bounded by live sessions. */
const lastSettle = new Map<string, OwnedSessionSettleOutcome>();

const SETTLE_OUTCOMES = {
  'session:completed': 'completed',
  'session:error': 'error',
  'session:waiting': 'waiting',
  'session:interrupted': 'interrupted',
} as const satisfies Record<string, OwnedSessionSettleOutcome>;

async function deliverSettle(sessionId: string, outcome: OwnedSessionSettleOutcome): Promise<void> {
  if (!sink?.hasListeners()) return;
  try {
    const session = await AISessionsRepository.get(sessionId);
    const owner = readSessionOwner(session?.metadata);
    if (!session?.workspacePath || !owner) return;
    // `session:completed` fires on every turn idle. A session with more queued
    // prompts is between turns, not settled (same rule as meta-agent updates).
    if (outcome === 'completed' && (await countPendingPrompts(sessionId)) > 0) return;
    sink?.emit(owner.extensionId, session.workspacePath, {
      sessionId,
      ownerKey: owner.key,
      outcome,
      createdBySessionId: session.createdBySessionId ?? null,
      workstreamId: session.parentSessionId ?? null,
      at: Date.now(),
      tokenUsage: readUsage(session.metadata),
    });
  } catch (error) {
    // A lost settle is recoverable (the owner can poll listOwned); log it so a
    // silent gap in the feed is visible in main.log.
    console.error(`[extensionSessions] settle delivery failed for ${sessionId} (${outcome}):`, error);
  }
}

async function countPendingPrompts(sessionId: string): Promise<number> {
  const { rows } = await database.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM queued_prompts WHERE session_id = $1 AND status = 'pending'`,
    [sessionId]
  );
  return Number(rows[0]?.count ?? '0');
}

// ---------------------------------------------------------------------------
// Ops
// ---------------------------------------------------------------------------

type Args = Record<string, unknown>;

export async function dispatchExtensionSessionsOp(
  scope: ExtensionSessionScope,
  op: string,
  rawArgs: unknown
): Promise<unknown> {
  const args = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as Args;
  switch (op) {
    case 'create':
      return createOwnedSession(scope, args as unknown as CreateOwnedSessionOptions);
    case 'createWorkstream':
      return createOwnedWorkstream(scope, args as unknown as CreateOwnedWorkstreamOptions);
    case 'sendPrompt':
      return sendPrompt(scope, requireString(args, 'sessionId'), requireString(args, 'prompt'));
    case 'getStatus':
      return getStatus(scope, requireString(args, 'sessionId'));
    case 'getResult':
      return getResult(scope, requireString(args, 'sessionId'));
    case 'listOwned':
      return listOwned(scope, optionalString(args, 'key'));
    case 'getUsage': {
      const since = Number(args.since);
      if (!Number.isFinite(since)) throw new Error('since (epoch ms) is required');
      return summarizeOwnedUsage(await queryOwnedRows(scope), { since, key: optionalString(args, 'key') });
    }
    case 'updateOwnerMetadata':
      return updateOwnerMetadata(scope, requireString(args, 'sessionId'), args.patch);
    case 'notifyUser':
      return notifyUser(scope, args as unknown as NotifyUserOptions);
    default:
      throw new Error(`Unknown sessions op: ${op}`);
  }
}

function requireString(args: Args, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} is required`);
  return value;
}

function optionalString(args: Args, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value ? value : undefined;
}

/** Load a session and prove the calling extension owns it in the calling workspace. */
async function requireOwned(scope: ExtensionSessionScope, sessionId: string) {
  const session = await AISessionsRepository.get(sessionId);
  const owner = readSessionOwner(session?.metadata);
  if (
    !session ||
    owner?.extensionId !== scope.extensionId ||
    !sameWorkspaceIdentity(session.workspacePath, scope.workspacePath)
  ) {
    throw new Error(`Session ${sessionId} is not owned by this extension in this workspace`);
  }
  return { session, owner };
}

function resolveModel(provider: string, model: string): string {
  const parsed = ModelIdentifier.tryParse(model);
  if (parsed) {
    if (parsed.provider !== provider) {
      throw new Error(`Model ${model} does not belong to provider ${provider}`);
    }
    return model;
  }
  const combined = `${provider}:${model}`;
  if (!ModelIdentifier.tryParse(combined)) throw new Error(`Invalid model: ${model}`);
  return combined;
}

function ownerFor(scope: ExtensionSessionScope, key: string, route: unknown): SessionOwner {
  // The extension id comes from the host scope, never from the module's args.
  return { extensionId: scope.extensionId, key, ...(route === true ? { routeChildUpdatesToOwner: true } : {}) };
}

async function createOwnedSession(
  scope: ExtensionSessionScope,
  options: CreateOwnedSessionOptions
): Promise<{ sessionId: string; queuedPromptId: string | null }> {
  const args = options as unknown as Args;
  const ownerKey = requireString(args, 'ownerKey');
  const name = requireString(args, 'name').trim();
  const provider = requireString(args, 'provider');
  const directive = optionalString(args, 'directive');
  // Fail fast: a directive stored on a provider that never reads it is lost silently.
  if (directive && !providerAppliesSessionDirective(provider)) {
    throw new Error(`Provider ${provider} does not apply session directives; use an agent provider or omit directive`);
  }
  const model = resolveModel(provider, requireString(args, 'model'));

  let effortLevel: string | undefined;
  if (options.effortLevel) {
    const match = EFFORT_LEVELS.find((entry) => entry.key === options.effortLevel);
    if (!match) throw new Error(`Invalid effortLevel "${options.effortLevel}"`);
    effortLevel = clampEffortLevel(match.key, model);
  }

  const workstreamId = optionalString(args, 'workstreamId');
  if (workstreamId) {
    const { session } = await requireOwned(scope, workstreamId);
    if (session.sessionType !== 'workstream') throw new Error(`${workstreamId} is not a workstream`);
  }
  const createdBySessionId = optionalString(args, 'createdBySessionId');
  if (createdBySessionId) await requireOwned(scope, createdBySessionId);

  const metadata: Record<string, unknown> = {
    [SESSION_OWNER_KEY]: ownerFor(scope, ownerKey, options.routeChildUpdatesToOwner),
    [OWNER_METADATA_KEY]: plainObject(options.ownerMetadata) ?? {},
    ...(directive ? { [SESSION_DIRECTIVE_KEY]: directive } : {}),
    ...(effortLevel ? { effortLevel } : {}),
  };

  const sessionId = randomUUID();
  // Owner, directive, and effort land in the same insert as the row, so no
  // reader (the provider's first turn, a settle, a spawn) can see it unowned.
  await AISessionsRepository.create({
    id: sessionId,
    provider,
    model,
    title: name,
    workspaceId: scope.workspacePath,
    sessionType: 'session',
    agentRole: 'standard',
    createdBySessionId: createdBySessionId ?? null,
    parentSessionId: workstreamId ?? null,
    hasBeenNamed: true,
    metadata,
  } as Parameters<typeof AISessionsRepository.create>[0]);
  broadcastSessionCreated({ workspacePath: scope.workspacePath, sessionId, parentSessionId: workstreamId });

  const prompt = options.prompt?.trim();
  if (!prompt) return { sessionId, queuedPromptId: null };
  const { queuedPromptId } = await enqueue(sessionId, scope.workspacePath, prompt);
  return { sessionId, queuedPromptId };
}

async function createOwnedWorkstream(
  scope: ExtensionSessionScope,
  options: CreateOwnedWorkstreamOptions
): Promise<{ workstreamId: string }> {
  const args = options as unknown as Args;
  const ownerKey = requireString(args, 'ownerKey');
  const name = requireString(args, 'name').trim();
  const workstreamId = randomUUID();
  await AISessionsRepository.create({
    id: workstreamId,
    provider: optionalString(args, 'provider') ?? 'claude-code',
    title: name,
    workspaceId: scope.workspacePath,
    sessionType: 'workstream',
    hasBeenNamed: true,
    metadata: {
      isWorkstreamRoot: true,
      [SESSION_OWNER_KEY]: ownerFor(scope, ownerKey, false),
      [OWNER_METADATA_KEY]: plainObject(options.ownerMetadata) ?? {},
    },
  } as Parameters<typeof AISessionsRepository.create>[0]);
  broadcastSessionCreated({ workspacePath: scope.workspacePath, sessionId: workstreamId });
  return { workstreamId };
}

async function enqueue(sessionId: string, workspacePath: string, prompt: string) {
  if (!queue) throw new Error('Extension session service is not started');
  const queued = await queue.queuePromptForSession(sessionId, prompt, undefined, {
    promptProvenance: { actor: 'system', origin: 'automation' },
  });
  await queue.triggerQueuedPromptProcessingForSession(sessionId, workspacePath, 'meta-agent');
  return { queuedPromptId: queued.id };
}

async function sendPrompt(scope: ExtensionSessionScope, sessionId: string, prompt: string) {
  const { session } = await requireOwned(scope, sessionId);
  if (session.sessionType === 'workstream') throw new Error(`${sessionId} is a workstream container`);
  return enqueue(sessionId, session.worktreePath || session.workspacePath || scope.workspacePath, prompt.trim());
}

async function getStatus(scope: ExtensionSessionScope, sessionId: string): Promise<OwnedSessionStatusResult> {
  const { session } = await requireOwned(scope, sessionId);
  const { rows } = await database.query<{ status: string | null; last_activity: unknown; updated_at: unknown; queued: string }>(
    `SELECT s.status, s.last_activity, s.updated_at,
            (SELECT COUNT(*) FROM queued_prompts q WHERE q.session_id = s.id AND q.status = 'pending')::text AS queued
       FROM ai_sessions s WHERE s.id = $1`,
    [sessionId]
  );
  const row = rows[0];
  return {
    sessionId,
    status: (row?.status || 'idle') as OwnedSessionStatus,
    title: session.title || 'Untitled Session',
    lastActivity: toMillis(row?.last_activity),
    updatedAt: toMillis(row?.updated_at),
    hasPendingPrompt: (session.metadata as Args | undefined)?.hasPendingPrompt === true,
    queuedPromptCount: Number(row?.queued ?? '0'),
  };
}

async function getResult(scope: ExtensionSessionScope, sessionId: string): Promise<OwnedSessionResult> {
  const { session } = await requireOwned(scope, sessionId);
  // Same extraction get_session_result gives an orchestrating agent.
  const data = JSON.parse(
    await dispatchMetaAgentTool('get_session_result', sessionId, scope.workspacePath, {
      sessionId,
      includeFullResponse: true,
    })
  ) as Args;
  const context = (plainObject((session.metadata as Args | undefined)?.tokenUsage) ?? {}).currentContext as
    | { tokens?: number; contextWindow?: number }
    | undefined;
  const pending = plainObject(data.pendingPrompt);
  return {
    sessionId,
    status: ((data.status as string) || 'idle') as OwnedSessionStatus,
    lastResponse: (data.fullResponse as string | null) ?? (data.lastResponse as string | null) ?? null,
    errorMessage: (data.errorMessage as string | null) ?? null,
    contextFill:
      context && typeof context.tokens === 'number' && typeof context.contextWindow === 'number'
        ? { tokens: context.tokens, contextWindow: context.contextWindow }
        : null,
    pendingPrompt: pending
      ? { promptId: String(pending.promptId ?? ''), promptType: String(pending.promptType ?? '') }
      : null,
    editedFiles: Array.isArray(data.editedFiles) ? (data.editedFiles as string[]) : [],
  };
}

// ---------------------------------------------------------------------------
// Roster and usage
// ---------------------------------------------------------------------------

/**
 * Every session one extension owns, in any workspace. The workspace match is
 * done in JS with `sameWorkspaceIdentity` (a project can be stored under
 * another spelling of the module's path, #1551), and archived rows are kept so
 * usage survives archiving; the roster drops them. `->`/`->>` behave the same
 * on PGLite and SQLite (>= 3.38) for a text comparison; the whole metadata
 * column is selected and parsed in JS because a sub-extracted object would come
 * back parsed on PGLite and as text on SQLite.
 */
export const OWNED_SESSIONS_SQL = `SELECT s.id, s.workspace_id, s.title, s.session_type, s.status, s.parent_session_id,
       s.created_by_session_id, s.is_archived, s.created_at, s.updated_at, s.last_activity, s.metadata
  FROM ai_sessions s
 WHERE s.metadata->'sessionOwner'->>'extensionId' = $1
 ORDER BY s.created_at DESC`;

interface OwnedRow {
  sessionId: string;
  key: string;
  archived: boolean;
  lastActivity: number;
  metadata: unknown;
  row: Record<string, unknown>;
}

async function queryOwnedRows(scope: ExtensionSessionScope): Promise<OwnedRow[]> {
  const { rows } = await database.query<Record<string, unknown>>(OWNED_SESSIONS_SQL, [scope.extensionId]);
  const inWorkspace = new Map<string, boolean>();
  const out: OwnedRow[] = [];
  for (const row of rows) {
    const owner = readSessionOwner(row.metadata);
    if (!owner || owner.extensionId !== scope.extensionId) continue;
    const ws = String(row.workspace_id ?? '');
    if (!inWorkspace.has(ws)) inWorkspace.set(ws, sameWorkspaceIdentity(ws, scope.workspacePath));
    if (!inWorkspace.get(ws)) continue;
    out.push({
      sessionId: String(row.id),
      key: owner.key,
      // 1/0 on SQLite, true/false on PGLite.
      archived: row.is_archived === true || row.is_archived === 1,
      lastActivity: Math.max(toMillis(row.last_activity) ?? 0, toMillis(row.updated_at) ?? 0),
      metadata: row.metadata,
      row,
    });
  }
  return out;
}

async function listOwned(scope: ExtensionSessionScope, key?: string): Promise<OwnedSessionSummary[]> {
  const owned = (await queryOwnedRows(scope)).filter((r) => !r.archived && (!key || r.key === key));
  if (owned.length === 0) return [];
  // One grouped count for the whole roster, not one query per session. Rows
  // for this extension's sessions in other workspaces are simply not looked up.
  const { rows: counts } = await database.query<{ session_id: string; count: string }>(
    `SELECT q.session_id, COUNT(*)::text AS count
       FROM queued_prompts q JOIN ai_sessions s ON s.id = q.session_id
      WHERE q.status = 'pending'
        AND s.metadata->'sessionOwner'->>'extensionId' = $1
      GROUP BY q.session_id`,
    [scope.extensionId]
  );
  const queued = new Map(counts.map((c) => [c.session_id, Number(c.count)]));
  return owned.map(({ sessionId, key: ownerKey, metadata, row }) => {
    const md = plainObject(typeof metadata === 'string' ? safeParse(metadata) : metadata) ?? {};
    return {
      sessionId,
      key: ownerKey,
      sessionType: String(row.session_type ?? 'session'),
      title: String(row.title ?? ''),
      workstreamId: (row.parent_session_id as string | null) ?? null,
      createdBySessionId: (row.created_by_session_id as string | null) ?? null,
      status: ((row.status as string) || 'idle') as OwnedSessionStatus,
      hasPendingPrompt: md.hasPendingPrompt === true,
      queuedPromptCount: queued.get(sessionId) ?? 0,
      createdAt: toMillis(row.created_at) ?? 0,
      updatedAt: toMillis(row.updated_at) ?? 0,
      ownerMetadata: readOwnerMetadata(md),
    };
  });
}

function readUsage(metadata: unknown): OwnedSessionUsage {
  const md = plainObject(typeof metadata === 'string' ? safeParse(metadata) : metadata);
  const usage = plainObject(md?.tokenUsage) ?? {};
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  // Cache counters were added after tokenUsage shipped; older rows read as 0.
  const inputTokens = num(usage.inputTokens);
  const outputTokens = num(usage.outputTokens);
  const cacheReadInputTokens = num(usage.cacheReadInputTokens);
  const cacheCreationInputTokens = num(usage.cacheCreationInputTokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens: num(usage.totalTokens),
    costUSD: num(usage.costUSD),
    cacheReadInputTokens,
    cacheCreationInputTokens,
    allTokens: inputTokens + outputTokens + cacheReadInputTokens + cacheCreationInputTokens,
  };
}

/**
 * Session-granular usage: the host persists only each session's lifetime
 * counters, so a session counts in full when it was active at or after `since`.
 */
export function summarizeOwnedUsage(
  rows: Array<{ sessionId: string; key: string; lastActivity: number; metadata: unknown }>,
  options: { since: number; key?: string }
): OwnedUsageReport {
  const totals: OwnedSessionUsage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUSD: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    allTokens: 0,
  };
  const sessions: OwnedUsageReport['sessions'] = [];
  for (const row of rows) {
    if (row.lastActivity < options.since) continue;
    if (options.key && row.key !== options.key) continue;
    const usage = readUsage(row.metadata);
    for (const field of Object.keys(totals) as Array<keyof OwnedSessionUsage>) {
      totals[field] += usage[field];
    }
    sessions.push({ sessionId: row.sessionId, key: row.key, lastActivity: row.lastActivity, ...usage });
  }
  return { since: options.since, totals, sessions };
}

// ---------------------------------------------------------------------------
// Owner metadata and notifications
// ---------------------------------------------------------------------------

const ownerMetadataWrites = new Map<string, Promise<unknown>>();

async function updateOwnerMetadata(scope: ExtensionSessionScope, sessionId: string, patch: unknown) {
  const changes = plainObject(patch);
  if (!changes) throw new Error('patch must be an object');
  // The store merges metadata one level deep, so the bag is read, merged, and
  // written whole. Serialize per session so two patches cannot drop each other.
  const previous = ownerMetadataWrites.get(sessionId) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    const { session } = await requireOwned(scope, sessionId);
    const bag = { ...readOwnerMetadata(session.metadata) };
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) delete bag[key];
      else bag[key] = value;
    }
    // Not AISessionsRepository.updateMetadata: the store strips owner keys
    // from every ordinary metadata write so nothing else can edit the bag.
    await database.query(OWNER_METADATA_MERGE_SQL, [JSON.stringify({ [OWNER_METADATA_KEY]: bag }), sessionId]);
    return { ownerMetadata: bag };
  });
  ownerMetadataWrites.set(sessionId, next);
  try {
    return await next;
  } finally {
    if (ownerMetadataWrites.get(sessionId) === next) ownerMetadataWrites.delete(sessionId);
  }
}

async function notifyUser(scope: ExtensionSessionScope, options: NotifyUserOptions): Promise<void> {
  const sessionId = requireString(options as unknown as Args, 'sessionId');
  await requireOwned(scope, sessionId);
  // Same delivery as the notify_user tool: OS notification, plus a phone push
  // when urgency is critical.
  await dispatchMetaAgentTool('notify_user', sessionId, scope.workspacePath, {
    sessionId,
    title: options.title,
    body: options.body,
    urgency: options.urgency ?? 'normal',
  });
}

function plainObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
