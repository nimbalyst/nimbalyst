import { open, readFile, stat } from 'fs/promises';
import path from 'path';

const RECOVERY_LEDGER_VERSION = 1 as const;
const MAX_RECOVERY_ATTEMPTS = 2;
const RECOVERY_CLAIM_LEASE_MS = 30_000;
const RECOVERY_DISPATCH_LEASE_MS = 5 * 60_000;
const MAX_TRANSCRIPT_BYTES = 256 * 1024;
const SAFE_TRANSCRIPT_ID = /^[A-Za-z0-9_-]+$/;

export type BackgroundAgentRecoveryState =
  | 'pending'
  | 'claimed'
  | 'dispatching'
  | 'dispatched'
  | 'retryable'
  | 'notify-only'
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'cancelled';

export interface RecoverySessionSnapshot {
  id: string;
  provider?: string;
  providerSessionId?: string;
  workspacePath?: string;
  metadata?: Record<string, unknown>;
}

export interface BackgroundAgentTranscriptEvidence {
  relativePath: string;
  parentRelativePath: string;
  sizeBytes: number;
  mtimeMs: number;
  fingerprint: string;
  lastEntryUuid?: string;
}

export interface BackgroundAgentRecoveryRecord {
  generation: string;
  generationNumber: number;
  identity: string;
  taskId: string;
  agentId: string;
  agentName?: string;
  description?: string;
  taskType: string;
  ownerInstanceId: string;
  providerSessionId: string;
  workspacePath: string;
  expectedTranscriptRelativePath: string;
  expectedParentTranscriptRelativePath: string;
  sourceTurnId: string;
  priorState: 'running';
  backgrounded: boolean;
  recoveryState: BackgroundAgentRecoveryState;
  attempts: number;
  observedAt: number;
  updatedAt: number;
  terminalAt?: number;
  claimedAt?: number;
  claimedBy?: string;
  claimedTurnId?: string;
  claimLeaseExpiresAt?: number;
  dispatchToolUseId?: string;
  dispatchTurnId?: string;
  dispatchedAt?: number;
  transcript?: BackgroundAgentTranscriptEvidence;
  lastReason?: string;
}

export interface BackgroundAgentRecoveryLedger {
  version: typeof RECOVERY_LEDGER_VERSION;
  tasks: Record<string, BackgroundAgentRecoveryRecord>;
}

export interface BackgroundAgentRecoveryDispatch {
  generation: string;
  taskId: string;
  agentId: string;
  agentName?: string;
  description?: string;
  providerSessionId: string;
  recipient: string;
  priorState: 'running';
  transcript: BackgroundAgentTranscriptEvidence;
}

export interface BackgroundAgentRecoveryNotice {
  generation: string;
  taskId: string;
  reason: string;
}

export interface TranscriptInspectionInput {
  workspacePath: string;
  providerSessionId: string;
  agentId: string;
}

export type TranscriptInspectionResult =
  | { ok: true; transcript: BackgroundAgentTranscriptEvidence }
  | {
      ok: false;
      reason: string;
      terminalStatus?: 'completed' | 'failed' | 'stopped' | 'cancelled';
    };

interface RecoveryCoordinatorDependencies {
  instanceId: string;
  now?: () => number;
  getSession: (sessionId: string) => Promise<RecoverySessionSnapshot | null>;
  mergeSessionMetadata: (
    sessionId: string,
    patch: Record<string, unknown>
  ) => Promise<void>;
  inspectTranscript?: (
    input: TranscriptInspectionInput
  ) => Promise<TranscriptInspectionResult>;
}

interface RecoveryTaskEventInput {
  sessionId: string;
  workspacePath: string;
  providerSessionId: string;
  turnId: string;
  launch?: { runInBackground?: boolean; name?: string };
  event:
    | {
        subtype: 'task_started';
        task_id: string;
        tool_use_id: string;
        task_type?: string;
        description?: string;
      }
    | {
        subtype: 'task_updated';
        task_id: string;
        patch?: {
          is_backgrounded?: boolean;
          status?: string;
          [key: string]: unknown;
        };
      }
    | {
        subtype: 'task_progress';
        task_id: string;
        description?: string;
        [key: string]: unknown;
      }
    | {
        subtype: 'task_notification';
        task_id: string;
        status?: string;
        [key: string]: unknown;
      };
}

interface CurrentTaskMetadata extends Record<string, unknown> {
  taskId: string;
  status: string;
}

const sessionMutationTails = new Map<string, Promise<void>>();

async function withSessionMutationLock<T>(
  sessionId: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = sessionMutationTails.get(sessionId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => gate);
  sessionMutationTails.set(sessionId, tail);

  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (sessionMutationTails.get(sessionId) === tail) {
      sessionMutationTails.delete(sessionId);
    }
  }
}

function emptyLedger(): BackgroundAgentRecoveryLedger {
  return { version: RECOVERY_LEDGER_VERSION, tasks: {} };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRecoveryRecord(
  value: unknown
): value is BackgroundAgentRecoveryRecord {
  if (!isObject(value)) return false;
  return (
    typeof value.generation === 'string' &&
    typeof value.generationNumber === 'number' &&
    typeof value.identity === 'string' &&
    typeof value.taskId === 'string' &&
    typeof value.agentId === 'string' &&
    typeof value.taskType === 'string' &&
    typeof value.ownerInstanceId === 'string' &&
    typeof value.providerSessionId === 'string' &&
    typeof value.workspacePath === 'string' &&
    typeof value.expectedTranscriptRelativePath === 'string' &&
    typeof value.expectedParentTranscriptRelativePath === 'string' &&
    typeof value.sourceTurnId === 'string' &&
    value.priorState === 'running' &&
    typeof value.backgrounded === 'boolean' &&
    typeof value.recoveryState === 'string' &&
    typeof value.attempts === 'number'
  );
}

export function getBackgroundAgentRecoveryLedger(
  metadata: Record<string, unknown> | undefined
): BackgroundAgentRecoveryLedger {
  const candidate = metadata?.backgroundAgentRecovery;
  if (
    !isObject(candidate) ||
    candidate.version !== RECOVERY_LEDGER_VERSION ||
    !isObject(candidate.tasks)
  ) {
    return emptyLedger();
  }

  const tasks: Record<string, BackgroundAgentRecoveryRecord> = {};
  for (const [key, value] of Object.entries(candidate.tasks)) {
    if (isRecoveryRecord(value)) tasks[key] = { ...value };
  }
  return { version: RECOVERY_LEDGER_VERSION, tasks };
}

export function encodeClaudeWorkspaceDir(workspacePath: string): string {
  return workspacePath.replace(/[^A-Za-z0-9]/g, '-');
}

function normalizedWorkspace(workspacePath: string): string {
  const normalized = path.normalize(workspacePath);
  return process.platform === 'win32'
    ? normalized.toLocaleLowerCase('en-US')
    : normalized;
}

function asForwardSlashes(value: string): string {
  return value.split(path.sep).join('/');
}

async function readBoundedJsonLines(filePath: string): Promise<{
  entries: Record<string, unknown>[];
  sizeBytes: number;
  mtimeMs: number;
}> {
  const fileStat = await stat(filePath);
  if (!fileStat.isFile() || fileStat.size === 0) {
    return { entries: [], sizeBytes: fileStat.size, mtimeMs: fileStat.mtimeMs };
  }

  let text: string;
  if (fileStat.size <= MAX_TRANSCRIPT_BYTES) {
    text = await readFile(filePath, 'utf8');
  } else {
    const half = Math.floor(MAX_TRANSCRIPT_BYTES / 2);
    const handle = await open(filePath, 'r');
    try {
      const head = Buffer.alloc(half);
      const tail = Buffer.alloc(half);
      const headRead = await handle.read(head, 0, half, 0);
      const tailPosition = Math.max(0, fileStat.size - half);
      const tailRead = await handle.read(tail, 0, half, tailPosition);
      text = `${head.subarray(0, headRead.bytesRead).toString('utf8')}\n${tail
        .subarray(0, tailRead.bytesRead)
        .toString('utf8')}`;
    } finally {
      await handle.close();
    }
  }

  const entries: Record<string, unknown>[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isObject(parsed)) entries.push(parsed);
    } catch {
      // A bounded read can begin or end inside a JSON line. Complete lines remain usable.
    }
  }
  return { entries, sizeBytes: fileStat.size, mtimeMs: fileStat.mtimeMs };
}

function terminalStatusFromEntries(
  entries: Record<string, unknown>[]
): 'completed' | 'failed' | 'stopped' | 'cancelled' | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const status = entries[index]?.status;
    if (
      status === 'completed' ||
      status === 'failed' ||
      status === 'stopped' ||
      status === 'cancelled'
    ) {
      return status;
    }
  }
  return undefined;
}

export async function inspectClaudeBackgroundAgentTranscript(
  input: TranscriptInspectionInput & {
    projectsDir: string;
  }
): Promise<TranscriptInspectionResult> {
  const { projectsDir, workspacePath, providerSessionId, agentId } = input;
  if (
    !SAFE_TRANSCRIPT_ID.test(providerSessionId) ||
    !SAFE_TRANSCRIPT_ID.test(agentId)
  ) {
    return { ok: false, reason: 'unsafe-transcript-identity' };
  }

  const encodedWorkspace = encodeClaudeWorkspaceDir(workspacePath);
  const projectDir = path.join(projectsDir, encodedWorkspace);
  const parentPath = path.join(projectDir, `${providerSessionId}.jsonl`);
  const sidecarPath = path.join(
    projectDir,
    providerSessionId,
    'subagents',
    `agent-${agentId}.jsonl`
  );

  let parent;
  try {
    parent = await readBoundedJsonLines(parentPath);
  } catch (error) {
    return {
      ok: false,
      reason:
        isObject(error) && error.code === 'ENOENT'
          ? 'missing-parent-transcript'
          : 'unreadable-parent-transcript',
    };
  }
  if (parent.entries.length === 0)
    return { ok: false, reason: 'malformed-parent-transcript' };
  const parentMatches = parent.entries.some(
    (entry) =>
      entry.sessionId === providerSessionId &&
      (typeof entry.cwd !== 'string' ||
        normalizedWorkspace(entry.cwd) === normalizedWorkspace(workspacePath))
  );
  if (!parentMatches)
    return { ok: false, reason: 'mismatched-parent-transcript' };

  let sidecar;
  try {
    sidecar = await readBoundedJsonLines(sidecarPath);
  } catch (error) {
    return {
      ok: false,
      reason:
        isObject(error) && error.code === 'ENOENT'
          ? 'missing-subagent-transcript'
          : 'unreadable-subagent-transcript',
    };
  }
  if (sidecar.entries.length === 0)
    return { ok: false, reason: 'malformed-subagent-transcript' };
  const matchingSidecarEntries = sidecar.entries.filter(
    (entry) =>
      entry.sessionId === providerSessionId && entry.agentId === agentId
  );
  if (matchingSidecarEntries.length === 0) {
    return { ok: false, reason: 'mismatched-subagent-transcript' };
  }

  const terminalStatus = terminalStatusFromEntries(matchingSidecarEntries);
  if (terminalStatus) {
    return {
      ok: false,
      reason: 'terminal-subagent-transcript',
      terminalStatus,
    };
  }

  const lastEntryUuid = [...matchingSidecarEntries]
    .reverse()
    .find((entry) => typeof entry.uuid === 'string')?.uuid as
    | string
    | undefined;
  const relativePath = asForwardSlashes(
    path.relative(projectsDir, sidecarPath)
  );
  const parentRelativePath = asForwardSlashes(
    path.relative(projectsDir, parentPath)
  );
  return {
    ok: true,
    transcript: {
      relativePath,
      parentRelativePath,
      sizeBytes: sidecar.sizeBytes,
      mtimeMs: sidecar.mtimeMs,
      fingerprint: `${sidecar.sizeBytes}:${Math.round(sidecar.mtimeMs)}:${
        lastEntryUuid ?? 'none'
      }`,
      lastEntryUuid,
    },
  };
}

function currentTasksFromMetadata(
  metadata: Record<string, unknown> | undefined
): CurrentTaskMetadata[] {
  if (!Array.isArray(metadata?.currentTasks)) return [];
  return metadata.currentTasks
    .filter(
      (task): task is Record<string, unknown> =>
        isObject(task) && typeof task.taskId === 'string'
    )
    .map((task) => ({
      ...task,
      taskId: task.taskId as string,
      status: typeof task.status === 'string' ? task.status : 'unknown',
    }));
}

function upsertCurrentTask(
  tasks: CurrentTaskMetadata[],
  taskId: string,
  patch: Record<string, unknown>
): CurrentTaskMetadata[] {
  const index = tasks.findIndex((task) => task.taskId === taskId);
  const previous = index >= 0 ? tasks[index] : undefined;
  const next = {
    ...(previous ?? {}),
    taskId,
    status:
      typeof patch.status === 'string'
        ? patch.status
        : previous?.status ?? 'unknown',
    ...patch,
  } as CurrentTaskMetadata;
  if (index < 0) return [...tasks, next];
  return tasks.map((task, taskIndex) => (taskIndex === index ? next : task));
}

function stopRunningTasks(
  tasks: CurrentTaskMetadata[],
  reason: string,
  now: number
): CurrentTaskMetadata[] {
  return tasks.map((task) =>
    task.status === 'running'
      ? {
          ...task,
          status: 'stopped',
          recoveryDisposition: reason,
          updatedAt: now,
        }
      : task
  );
}

function latestRecordForTask(
  ledger: BackgroundAgentRecoveryLedger,
  taskId: string
): BackgroundAgentRecoveryRecord | undefined {
  return Object.values(ledger.tasks)
    .filter((record) => record.taskId === taskId)
    .sort((left, right) => right.generationNumber - left.generationNumber)[0];
}

function latestRecordForIdentity(
  ledger: BackgroundAgentRecoveryLedger,
  identity: string
): BackgroundAgentRecoveryRecord | undefined {
  return Object.values(ledger.tasks)
    .filter((record) => record.identity === identity)
    .sort((left, right) => right.generationNumber - left.generationNumber)[0];
}

function terminalRecoveryState(
  status: string | undefined
): BackgroundAgentRecoveryState | undefined {
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'failed';
  if (status === 'stopped') return 'stopped';
  if (status === 'cancelled') return 'cancelled';
  return undefined;
}

function isTerminalRecoveryState(state: BackgroundAgentRecoveryState): boolean {
  return [
    'notify-only',
    'completed',
    'failed',
    'stopped',
    'cancelled',
  ].includes(state);
}

export class BackgroundAgentRecoveryCoordinator {
  private readonly instanceId: string;
  private readonly now: () => number;
  private readonly getSession: RecoveryCoordinatorDependencies['getSession'];
  private readonly mergeSessionMetadata: RecoveryCoordinatorDependencies['mergeSessionMetadata'];
  private readonly inspectTranscript: NonNullable<
    RecoveryCoordinatorDependencies['inspectTranscript']
  >;

  constructor(dependencies: RecoveryCoordinatorDependencies) {
    this.instanceId = dependencies.instanceId;
    this.now = dependencies.now ?? Date.now;
    this.getSession = dependencies.getSession;
    this.mergeSessionMetadata = dependencies.mergeSessionMetadata;
    this.inspectTranscript =
      dependencies.inspectTranscript ??
      (async () => ({
        ok: false,
        reason: 'transcript-inspector-unavailable',
      }));
  }

  private async mutateSession<T>(
    sessionId: string,
    mutation: (
      session: RecoverySessionSnapshot,
      ledger: BackgroundAgentRecoveryLedger,
      currentTasks: CurrentTaskMetadata[]
    ) =>
      | Promise<{
          result: T;
          currentTasks?: CurrentTaskMetadata[];
          write?: boolean;
        }>
      | { result: T; currentTasks?: CurrentTaskMetadata[]; write?: boolean }
  ): Promise<T | undefined> {
    return withSessionMutationLock(sessionId, async () => {
      const session = await this.getSession(sessionId);
      if (!session) return undefined;
      const ledger = getBackgroundAgentRecoveryLedger(session.metadata);
      const currentTasks = currentTasksFromMetadata(session.metadata);
      const outcome = await mutation(session, ledger, currentTasks);
      if (outcome.write !== false) {
        const patch: Record<string, unknown> = {
          backgroundAgentRecovery: ledger,
        };
        if (outcome.currentTasks) patch.currentTasks = outcome.currentTasks;
        await this.mergeSessionMetadata(sessionId, patch);
      }
      return outcome.result;
    });
  }

  async observeTaskEvent(input: RecoveryTaskEventInput): Promise<void> {
    await this.mutateSession(
      input.sessionId,
      (_session, ledger, currentTasks) => {
        const observedAt = this.now();
        if (input.event.subtype === 'task_started') {
          const taskType = input.event.task_type ?? 'local_agent';
          const identity = `${input.providerSessionId}:${input.event.tool_use_id}`;
          const latest = latestRecordForIdentity(ledger, identity);
          const shouldCreateRecoveredGeneration =
            latest?.recoveryState === 'dispatched' &&
            latest.dispatchTurnId === input.turnId;

          if (
            latest?.sourceTurnId === input.turnId &&
            latest.recoveryState === 'pending'
          ) {
            latest.updatedAt = observedAt;
            latest.backgrounded =
              input.launch?.runInBackground ?? latest.backgrounded;
            latest.agentName = input.launch?.name ?? latest.agentName;
            return {
              result: undefined,
              currentTasks: upsertCurrentTask(
                currentTasks,
                input.event.task_id,
                {
                  status: 'running',
                  description: input.event.description,
                  taskType,
                  toolUseId: input.event.tool_use_id,
                  isBackgrounded: latest.backgrounded,
                  updatedAt: observedAt,
                }
              ),
            };
          }

          if (latest && !shouldCreateRecoveredGeneration) {
            latest.updatedAt = observedAt;
            return {
              result: undefined,
              currentTasks,
            };
          }

          const generationNumber = (latest?.generationNumber ?? 0) + 1;
          const generation = `${identity}:g${generationNumber}`;
          ledger.tasks[generation] = {
            generation,
            generationNumber,
            identity,
            taskId: input.event.task_id,
            agentId: input.event.tool_use_id,
            agentName: input.launch?.name,
            description: input.event.description,
            taskType,
            ownerInstanceId: this.instanceId,
            providerSessionId: input.providerSessionId,
            workspacePath: input.workspacePath,
            expectedTranscriptRelativePath: `${encodeClaudeWorkspaceDir(
              input.workspacePath
            )}/${input.providerSessionId}/subagents/agent-${
              input.event.tool_use_id
            }.jsonl`,
            expectedParentTranscriptRelativePath: `${encodeClaudeWorkspaceDir(
              input.workspacePath
            )}/${input.providerSessionId}.jsonl`,
            sourceTurnId: input.turnId,
            priorState: 'running',
            backgrounded: input.launch?.runInBackground === true,
            recoveryState: 'pending',
            attempts: 0,
            observedAt,
            updatedAt: observedAt,
          };
          return {
            result: undefined,
            currentTasks: upsertCurrentTask(currentTasks, input.event.task_id, {
              status: 'running',
              description: input.event.description,
              taskType,
              toolUseId: input.event.tool_use_id,
              isBackgrounded: input.launch?.runInBackground === true,
              updatedAt: observedAt,
            }),
          };
        }

        const record = latestRecordForTask(ledger, input.event.task_id);
        const ignoreLateNonTerminalEvent =
          record !== undefined &&
          isTerminalRecoveryState(record.recoveryState) &&
          (input.event.subtype === 'task_progress' ||
            (input.event.subtype === 'task_updated' &&
              terminalRecoveryState(input.event.patch?.status) === undefined));
        if (record) {
          record.updatedAt = observedAt;
          if (input.event.subtype === 'task_updated') {
            if (typeof input.event.patch?.is_backgrounded === 'boolean') {
              record.backgrounded = input.event.patch.is_backgrounded;
            }
            const terminalState = terminalRecoveryState(
              input.event.patch?.status
            );
            if (terminalState) {
              record.recoveryState = terminalState;
              record.terminalAt = observedAt;
              record.lastReason = `sdk-task-${terminalState}`;
            }
          } else if (input.event.subtype === 'task_notification') {
            const terminalState = terminalRecoveryState(
              input.event.status ?? 'completed'
            );
            if (terminalState) {
              record.recoveryState = terminalState;
              record.terminalAt = observedAt;
              record.lastReason = `sdk-task-${terminalState}`;
            }
          }
        }

        if (ignoreLateNonTerminalEvent) {
          return { result: undefined, currentTasks };
        }

        const taskPatch: Record<string, unknown> = { updatedAt: observedAt };
        if (input.event.subtype === 'task_updated') {
          Object.assign(taskPatch, input.event.patch);
          if (typeof input.event.patch?.is_backgrounded === 'boolean') {
            taskPatch.isBackgrounded = input.event.patch.is_backgrounded;
          }
        } else if (input.event.subtype === 'task_notification') {
          taskPatch.status = input.event.status ?? 'completed';
        } else if (input.event.description) {
          taskPatch.description = input.event.description;
        }
        return {
          result: undefined,
          currentTasks: upsertCurrentTask(
            currentTasks,
            input.event.task_id,
            taskPatch
          ),
        };
      }
    );
  }

  async claimResumeDispatches(input: {
    sessionId: string;
    workspacePath: string;
    providerSessionId?: string;
    turnId: string;
    isResume: boolean;
  }): Promise<{
    dispatches: BackgroundAgentRecoveryDispatch[];
    notices: BackgroundAgentRecoveryNotice[];
  }> {
    const result = await this.mutateSession(
      input.sessionId,
      async (session, ledger, currentTasks) => {
        const dispatches: BackgroundAgentRecoveryDispatch[] = [];
        const notices: BackgroundAgentRecoveryNotice[] = [];
        const checkedAt = this.now();

        if (!input.isResume || !input.providerSessionId) {
          for (const record of Object.values(ledger.tasks)) {
            if (
              !['pending', 'retryable', 'claimed', 'dispatching'].includes(
                record.recoveryState
              )
            )
              continue;
            record.recoveryState = 'notify-only';
            record.lastReason = 'non-resume-start';
            record.updatedAt = checkedAt;
            notices.push({
              generation: record.generation,
              taskId: SAFE_TRANSCRIPT_ID.test(record.taskId)
                ? record.taskId
                : 'unverified-task',
              reason: record.lastReason,
            });
          }
          return {
            result: { dispatches, notices },
            currentTasks: stopRunningTasks(
              currentTasks,
              'non-resume-start',
              checkedAt
            ),
          };
        }
        if (
          (session.provider && session.provider !== 'claude-code') ||
          session.providerSessionId !== input.providerSessionId ||
          (session.workspacePath &&
            normalizedWorkspace(session.workspacePath) !==
              normalizedWorkspace(input.workspacePath))
        ) {
          for (const record of Object.values(ledger.tasks)) {
            if (
              !['pending', 'retryable', 'claimed', 'dispatching'].includes(
                record.recoveryState
              )
            )
              continue;
            record.recoveryState = 'notify-only';
            record.lastReason = 'unverified-provider-session';
            record.updatedAt = checkedAt;
            notices.push({
              generation: record.generation,
              taskId: SAFE_TRANSCRIPT_ID.test(record.taskId)
                ? record.taskId
                : 'unverified-task',
              reason: record.lastReason,
            });
          }
          return {
            result: { dispatches, notices },
            currentTasks: stopRunningTasks(
              currentTasks,
              'unverified-provider-session',
              checkedAt
            ),
          };
        }

        const records = Object.values(ledger.tasks).sort(
          (left, right) => left.observedAt - right.observedAt
        );
        const stoppedTasks = stopRunningTasks(
          currentTasks,
          'provider-recycled',
          checkedAt
        );
        for (const record of records) {
          if (record.sourceTurnId === input.turnId) continue;
          if (
            !['pending', 'retryable', 'claimed', 'dispatching'].includes(
              record.recoveryState
            )
          )
            continue;
          if (record.claimedTurnId === input.turnId) continue;
          if (
            record.recoveryState === 'dispatching' &&
            (record.claimLeaseExpiresAt ?? 0) <= checkedAt
          ) {
            // The native send begins only after guardNativeSendMessage has
            // durably moved the generation to dispatching. If the process dies
            // before the tool result is persisted, the send may already have
            // reached Claude. There is no native idempotency key, so reclaiming
            // this lease could duplicate the continuation.
            record.recoveryState = 'notify-only';
            record.lastReason = 'ambiguous-dispatch';
            record.updatedAt = checkedAt;
            record.claimLeaseExpiresAt = undefined;
            notices.push({
              generation: record.generation,
              taskId: record.taskId,
              reason: record.lastReason,
            });
            continue;
          }
          if (
            (record.recoveryState === 'claimed' ||
              record.recoveryState === 'dispatching') &&
            (record.claimLeaseExpiresAt ?? 0) > checkedAt
          ) {
            continue;
          }
          if (record.providerSessionId !== input.providerSessionId) {
            record.recoveryState = 'notify-only';
            record.lastReason = 'record-provider-session-mismatch';
            record.updatedAt = checkedAt;
            notices.push({
              generation: record.generation,
              taskId: record.taskId,
              reason: record.lastReason,
            });
            continue;
          }
          if (
            normalizedWorkspace(record.workspacePath) !==
            normalizedWorkspace(input.workspacePath)
          ) {
            record.recoveryState = 'notify-only';
            record.lastReason = 'record-workspace-mismatch';
            record.updatedAt = checkedAt;
            notices.push({
              generation: record.generation,
              taskId: record.taskId,
              reason: record.lastReason,
            });
            continue;
          }
          if (record.attempts >= MAX_RECOVERY_ATTEMPTS) {
            record.recoveryState = 'notify-only';
            record.lastReason = 'recovery-attempt-limit';
            record.updatedAt = checkedAt;
            notices.push({
              generation: record.generation,
              taskId: record.taskId,
              reason: record.lastReason,
            });
            continue;
          }
          if (
            !SAFE_TRANSCRIPT_ID.test(record.taskId) ||
            !SAFE_TRANSCRIPT_ID.test(record.agentId)
          ) {
            record.recoveryState = 'notify-only';
            record.lastReason = 'unsafe-task-identity';
            record.updatedAt = checkedAt;
            notices.push({
              generation: record.generation,
              taskId: 'unverified-task',
              reason: record.lastReason,
            });
            continue;
          }
          if (record.taskType !== 'local_agent' || !record.backgrounded) {
            record.recoveryState = 'notify-only';
            record.lastReason =
              record.taskType !== 'local_agent'
                ? 'unsupported-background-task-type'
                : 'task-was-not-backgrounded';
            record.updatedAt = checkedAt;
            notices.push({
              generation: record.generation,
              taskId: record.taskId,
              reason: record.lastReason,
            });
            continue;
          }

          const inspection = await this.inspectTranscript({
            workspacePath: record.workspacePath,
            providerSessionId: record.providerSessionId,
            agentId: record.agentId,
          });
          if (!inspection.ok) {
            const terminalState = inspection.terminalStatus
              ? terminalRecoveryState(inspection.terminalStatus)
              : undefined;
            record.recoveryState = terminalState ?? 'notify-only';
            record.lastReason = inspection.reason;
            record.updatedAt = checkedAt;
            if (terminalState) record.terminalAt = checkedAt;
            notices.push({
              generation: record.generation,
              taskId: record.taskId,
              reason: inspection.reason,
            });
            continue;
          }
          if (
            inspection.transcript.relativePath !==
              record.expectedTranscriptRelativePath ||
            inspection.transcript.parentRelativePath !==
              record.expectedParentTranscriptRelativePath
          ) {
            record.recoveryState = 'notify-only';
            record.lastReason = 'transcript-provenance-mismatch';
            record.updatedAt = checkedAt;
            notices.push({
              generation: record.generation,
              taskId: record.taskId,
              reason: record.lastReason,
            });
            continue;
          }

          record.attempts += 1;
          record.recoveryState = 'claimed';
          record.claimedAt = checkedAt;
          record.claimedBy = this.instanceId;
          record.claimedTurnId = input.turnId;
          record.claimLeaseExpiresAt = checkedAt + RECOVERY_CLAIM_LEASE_MS;
          record.dispatchToolUseId = undefined;
          record.dispatchTurnId = undefined;
          record.transcript = inspection.transcript;
          record.lastReason = 'verified-surviving-transcript';
          record.updatedAt = checkedAt;
          dispatches.push({
            generation: record.generation,
            taskId: record.taskId,
            agentId: record.agentId,
            agentName: record.agentName,
            description: record.description,
            providerSessionId: record.providerSessionId,
            recipient: record.agentId,
            priorState: record.priorState,
            transcript: inspection.transcript,
          });
        }
        return { result: { dispatches, notices }, currentTasks: stoppedTasks };
      }
    );
    return result ?? { dispatches: [], notices: [] };
  }

  async guardNativeSendMessage(input: {
    sessionId: string;
    turnId: string;
    toolUseId: string;
    input: Record<string, unknown>;
    plannedGenerations?: readonly string[];
  }): Promise<{ matched: boolean; allow: boolean; reason?: string }> {
    const result = await this.mutateSession<{
      matched: boolean;
      allow: boolean;
      reason?: string;
    }>(input.sessionId, async (_session, ledger) => {
      const messageType = input.input.type;
      const recipient =
        typeof input.input.to === 'string'
          ? input.input.to
          : input.input.recipient;
      if (
        (messageType !== undefined && messageType !== 'message') ||
        typeof recipient !== 'string'
      ) {
        return { result: { matched: false, allow: true }, write: false };
      }

      const activeRecords = Object.values(ledger.tasks).filter((candidate) => {
        if (candidate.transcript === undefined) return false;
        if (
          ['claimed', 'dispatching', 'retryable'].includes(
            candidate.recoveryState
          )
        ) {
          return true;
        }
        return (
          candidate.claimedTurnId === input.turnId &&
          (candidate.recoveryState === 'dispatched' ||
            isTerminalRecoveryState(candidate.recoveryState))
        );
      });
      const exactIdentityMatches = activeRecords.filter(
        (candidate) =>
          candidate.taskId === recipient || candidate.agentId === recipient
      );
      const nameMatches = activeRecords.filter(
        (candidate) => candidate.agentName === recipient
      );
      const record = (
        exactIdentityMatches.length > 0
          ? exactIdentityMatches
          : nameMatches.length === 1
          ? nameMatches
          : []
      ).sort((left, right) => right.updatedAt - left.updatedAt)[0];
      if (!record)
        return { result: { matched: false, allow: true }, write: false };

      if (
        record.recoveryState === 'dispatched' ||
        isTerminalRecoveryState(record.recoveryState)
      ) {
        return {
          result: {
            matched: true,
            allow: false,
            reason: `background-agent-recovery-${record.recoveryState}`,
          },
          write: false,
        };
      }

      if (
        record.recoveryState === 'retryable' &&
        record.claimedTurnId === input.turnId
      ) {
        return {
          result: {
            matched: true,
            allow: false,
            reason: 'background-agent-recovery-attempt-finished',
          },
          write: false,
        };
      }
      if (record.recoveryState === 'retryable') {
        record.dispatchToolUseId = undefined;
        record.dispatchTurnId = undefined;
      }
      if (record.dispatchToolUseId) {
        if (record.dispatchToolUseId === input.toolUseId) {
          return { result: { matched: true, allow: true }, write: false };
        }
        return {
          result: {
            matched: true,
            allow: false,
            reason: 'background-agent-recovery-already-dispatched',
          },
          write: false,
        };
      }

      const inspection = await this.inspectTranscript({
        workspacePath: record.workspacePath,
        providerSessionId: record.providerSessionId,
        agentId: record.agentId,
      });
      if (!inspection.ok) {
        const terminalState = inspection.terminalStatus
          ? terminalRecoveryState(inspection.terminalStatus)
          : undefined;
        record.recoveryState = terminalState ?? 'notify-only';
        record.lastReason = inspection.reason;
        record.updatedAt = this.now();
        if (terminalState) record.terminalAt = record.updatedAt;
        return {
          result: { matched: true, allow: false, reason: inspection.reason },
        };
      }
      if (
        inspection.transcript.relativePath !==
          record.expectedTranscriptRelativePath ||
        inspection.transcript.parentRelativePath !==
          record.expectedParentTranscriptRelativePath
      ) {
        record.recoveryState = 'notify-only';
        record.lastReason = 'transcript-provenance-mismatch';
        record.updatedAt = this.now();
        return {
          result: {
            matched: true,
            allow: false,
            reason: record.lastReason,
          },
        };
      }
      if (
        record.transcript &&
        inspection.transcript.fingerprint !== record.transcript.fingerprint
      ) {
        record.recoveryState = 'notify-only';
        record.lastReason = 'transcript-changed-after-claim';
        record.updatedAt = this.now();
        return {
          result: {
            matched: true,
            allow: false,
            reason: record.lastReason,
          },
        };
      }
      record.transcript = inspection.transcript;

      const wasRetryable = record.recoveryState === 'retryable';
      record.recoveryState = 'dispatching';
      if (record.claimedTurnId !== input.turnId && wasRetryable) {
        record.attempts = Math.min(MAX_RECOVERY_ATTEMPTS, record.attempts + 1);
      }
      record.claimedBy = this.instanceId;
      record.claimedTurnId = input.turnId;
      record.claimLeaseExpiresAt = this.now() + RECOVERY_DISPATCH_LEASE_MS;
      record.dispatchToolUseId = input.toolUseId;
      record.dispatchTurnId = input.turnId;
      record.lastReason = 'native-sendmessage-dispatching';
      record.updatedAt = this.now();
      return { result: { matched: true, allow: true } };
    });
    if (result) return result;
    if ((input.plannedGenerations?.length ?? 0) > 0) {
      return {
        matched: true,
        allow: false,
        reason: 'background-agent-recovery-session-missing',
      };
    }
    return { matched: false, allow: true };
  }

  async observeNativeSendMessageResult(input: {
    sessionId: string;
    turnId: string;
    toolUseId: string;
    isError: boolean;
    content?: unknown;
  }): Promise<void> {
    await this.mutateSession(input.sessionId, (_session, ledger) => {
      const record = Object.values(ledger.tasks).find(
        (candidate) =>
          candidate.dispatchToolUseId === input.toolUseId &&
          candidate.dispatchTurnId === input.turnId
      );
      if (!record) return { result: undefined, write: false };
      if (
        !['claimed', 'dispatching', 'retryable'].includes(record.recoveryState)
      ) {
        return { result: undefined, write: false };
      }

      const observedAt = this.now();
      if (input.isError) {
        record.recoveryState =
          record.attempts < MAX_RECOVERY_ATTEMPTS ? 'retryable' : 'notify-only';
        record.lastReason = 'native-dispatch-rejected';
      } else {
        record.recoveryState = 'dispatched';
        record.dispatchedAt = observedAt;
        record.lastReason = 'native-sendmessage-dispatched';
      }
      record.claimLeaseExpiresAt = undefined;
      record.updatedAt = observedAt;
      return { result: undefined };
    });
  }

  async finishRecoveryTurn(input: {
    sessionId: string;
    turnId: string;
    plannedGenerations: string[];
  }): Promise<void> {
    const planned = new Set(input.plannedGenerations);
    await this.mutateSession(input.sessionId, (_session, ledger) => {
      let changed = false;
      const finishedAt = this.now();
      for (const record of Object.values(ledger.tasks)) {
        const belongsToTurn =
          planned.has(record.generation) ||
          record.dispatchTurnId === input.turnId ||
          (record.claimedTurnId === input.turnId &&
            record.transcript !== undefined);
        if (!belongsToTurn || record.claimedTurnId !== input.turnId) continue;
        if (
          record.recoveryState !== 'claimed' &&
          record.recoveryState !== 'dispatching'
        )
          continue;
        if (record.recoveryState === 'dispatching') {
          // The pre-tool guard persisted dispatching before allowing the native
          // call, so lack of a result is ambiguous and must never be retried.
          record.recoveryState = 'notify-only';
          record.lastReason = 'ambiguous-dispatch';
        } else {
          // A claimed generation that never reached the first-send guard is
          // safe to offer on one later recovery turn.
          record.recoveryState =
            record.attempts < MAX_RECOVERY_ATTEMPTS
              ? 'retryable'
              : 'notify-only';
          record.lastReason = 'native-dispatch-not-observed';
        }
        record.claimLeaseExpiresAt = undefined;
        record.updatedAt = finishedAt;
        changed = true;
      }
      return { result: undefined, write: changed };
    });
  }

  async observeExplicitTaskStop(input: {
    sessionId: string;
    taskId: string;
  }): Promise<boolean> {
    const result = await this.mutateSession(
      input.sessionId,
      (_session, ledger, currentTasks) => {
        const records = Object.values(ledger.tasks).filter(
          (record) => record.taskId === input.taskId
        );
        if (records.length === 0) {
          return { result: false, write: false };
        }

        const stoppedAt = this.now();
        let changed = false;
        for (const record of records) {
          if (
            ![
              'pending',
              'claimed',
              'dispatching',
              'dispatched',
              'retryable',
              'notify-only',
            ].includes(record.recoveryState)
          ) {
            continue;
          }
          record.recoveryState = 'stopped';
          record.terminalAt = stoppedAt;
          record.updatedAt = stoppedAt;
          record.lastReason = 'native-task-stop-succeeded';
          record.claimLeaseExpiresAt = undefined;
          changed = true;
        }

        if (!changed) return { result: true, write: false };
        return {
          result: true,
          currentTasks: upsertCurrentTask(currentTasks, input.taskId, {
            status: 'stopped',
            recoveryDisposition: 'native-task-stop-succeeded',
            updatedAt: stoppedAt,
          }),
        };
      }
    );
    return result ?? false;
  }

  async suppressRunning(sessionId: string, reason: string): Promise<void> {
    await this.mutateSession(sessionId, (_session, ledger, currentTasks) => {
      const suppressedAt = this.now();
      let stoppedTasks = stopRunningTasks(
        currentTasks,
        reason,
        suppressedAt
      );
      for (const record of Object.values(ledger.tasks)) {
        if (
          [
            'pending',
            'claimed',
            'dispatching',
            'retryable',
            'dispatched',
          ].includes(record.recoveryState)
        ) {
          record.recoveryState = 'cancelled';
          record.terminalAt = suppressedAt;
          record.updatedAt = suppressedAt;
          record.lastReason = reason;
          record.claimLeaseExpiresAt = undefined;
          stoppedTasks = upsertCurrentTask(stoppedTasks, record.taskId, {
            status: 'stopped',
            recoveryDisposition: reason,
            updatedAt: suppressedAt,
          });
        }
      }
      return {
        result: undefined,
        currentTasks: stoppedTasks,
      };
    });
  }
}

export function buildBackgroundAgentRecoveryInstruction(
  dispatches: BackgroundAgentRecoveryDispatch[],
  notices: BackgroundAgentRecoveryNotice[]
): string {
  if (dispatches.length === 0 && notices.length === 0) return '';

  const lines = [
    '<background-agent-recovery>',
    'Recover only the verified original Claude background agents listed below.',
  ];
  for (const dispatch of dispatches) {
    lines.push(
      `- For task ${dispatch.taskId}, call native SendMessage exactly once with to: '${dispatch.agentId}' and a 5-10 word summary to continue the original agent from its surviving transcript (${dispatch.transcript.relativePath}).`
    );
  }
  if (dispatches.length > 1) {
    lines.push(
      'Make the recovery SendMessage calls sequentially, not in parallel.'
    );
  }
  if (notices.length > 0) {
    lines.push(
      'Do not auto-resume these tasks; report their durable recovery status instead:'
    );
    for (const notice of notices) {
      const safeTaskId = SAFE_TRANSCRIPT_ID.test(notice.taskId)
        ? notice.taskId
        : 'unverified-task';
      const safeReason = /^[a-z0-9-]+$/.test(notice.reason)
        ? notice.reason
        : 'unverified-recovery-status';
      lines.push(`- ${safeTaskId}: ${safeReason}`);
    }
  }
  lines.push(
    'Do not launch a replacement Agent and do not reconstruct an agent from summary text.',
    "After the native SendMessage call, continue with the user's ordinary request.",
    '</background-agent-recovery>'
  );
  return lines.join('\n');
}
