import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BackgroundAgentRecoveryCoordinator,
  buildBackgroundAgentRecoveryInstruction,
  encodeClaudeWorkspaceDir,
  getBackgroundAgentRecoveryLedger,
  inspectClaudeBackgroundAgentTranscript,
  type RecoverySessionSnapshot,
} from '../backgroundTaskRecovery';

const SESSION_ID = 'nimbalyst-session-1';
const PROVIDER_SESSION_ID = 'provider-session-1';
const WORKSPACE_PATH = 'D:\\fixtures\\recovery-workspace';
const TASK_ID = 'task-agent-1';
const AGENT_ID = 'toolu_agent_1';

type MutableSession = RecoverySessionSnapshot & {
  metadata: Record<string, unknown>;
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe('BackgroundAgentRecoveryCoordinator', () => {
  let projectsDir: string;
  let clock: number;
  let sessions: Map<string, MutableSession>;

  beforeEach(async () => {
    projectsDir = await mkdtemp(path.join(tmpdir(), 'nim-253-recovery-'));
    clock = 1_000;
    sessions = new Map([
      [
        SESSION_ID,
        {
          id: SESSION_ID,
          provider: 'claude-code',
          providerSessionId: PROVIDER_SESSION_ID,
          workspacePath: WORKSPACE_PATH,
          metadata: { unrelatedLifecycleMetadata: { keep: true } },
        },
      ],
    ]);
  });

  afterEach(async () => {
    await rm(projectsDir, { recursive: true, force: true });
  });

  function coordinator(instanceId: string): BackgroundAgentRecoveryCoordinator {
    return new BackgroundAgentRecoveryCoordinator({
      instanceId,
      now: () => ++clock,
      getSession: async (sessionId) => {
        const session = sessions.get(sessionId);
        return session ? clone(session) : null;
      },
      mergeSessionMetadata: async (sessionId, patch) => {
        const session = sessions.get(sessionId);
        if (!session) return;
        session.metadata = { ...session.metadata, ...clone(patch) };
      },
      inspectTranscript: (input) =>
        inspectClaudeBackgroundAgentTranscript({
          ...input,
          projectsDir,
        }),
    });
  }

  async function writeTranscriptFixture(
    options: {
      providerSessionId?: string;
      agentId?: string;
      parentEntrySessionId?: string;
      sidecarEntrySessionId?: string;
      sidecarEntryAgentId?: string;
      terminalStatus?: 'completed' | 'failed' | 'stopped';
    } = {}
  ): Promise<void> {
    const providerSessionId = options.providerSessionId ?? PROVIDER_SESSION_ID;
    const agentId = options.agentId ?? AGENT_ID;
    const projectDir = path.join(
      projectsDir,
      encodeClaudeWorkspaceDir(WORKSPACE_PATH)
    );
    const subagentsDir = path.join(projectDir, providerSessionId, 'subagents');
    await mkdir(subagentsDir, { recursive: true });

    await writeFile(
      path.join(projectDir, `${providerSessionId}.jsonl`),
      `${JSON.stringify({
        type: 'user',
        uuid: 'parent-user-1',
        sessionId: options.parentEntrySessionId ?? providerSessionId,
        cwd: WORKSPACE_PATH,
        message: { role: 'user', content: 'parent prompt' },
      })}\n`,
      'utf8'
    );

    const sidecarEntries: Record<string, unknown>[] = [
      {
        type: 'user',
        uuid: 'agent-user-1',
        sessionId: options.sidecarEntrySessionId ?? providerSessionId,
        agentId: options.sidecarEntryAgentId ?? agentId,
        isSidechain: true,
        message: { role: 'user', content: 'original delegated task' },
      },
      {
        type: 'assistant',
        uuid: 'agent-assistant-1',
        sessionId: options.sidecarEntrySessionId ?? providerSessionId,
        agentId: options.sidecarEntryAgentId ?? agentId,
        isSidechain: true,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'still working' }],
        },
      },
    ];
    if (options.terminalStatus) {
      sidecarEntries.push({
        type: 'system',
        subtype: 'task_notification',
        sessionId: providerSessionId,
        agentId,
        status: options.terminalStatus,
      });
    }

    await writeFile(
      path.join(subagentsDir, `agent-${agentId}.jsonl`),
      `${sidecarEntries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
      'utf8'
    );
  }

  async function recordRunningBackgroundAgent(
    owner: BackgroundAgentRecoveryCoordinator,
    turnId = 'provider-a:turn-1',
    sessionId = SESSION_ID
  ): Promise<void> {
    await owner.observeTaskEvent({
      sessionId,
      workspacePath: WORKSPACE_PATH,
      providerSessionId: PROVIDER_SESSION_ID,
      turnId,
      launch: { runInBackground: true, name: 'researcher' },
      event: {
        subtype: 'task_started',
        task_id: TASK_ID,
        tool_use_id: AGENT_ID,
        task_type: 'local_agent',
        description: 'Inspect the original source',
      },
    });
    await owner.observeTaskEvent({
      sessionId,
      workspacePath: WORKSPACE_PATH,
      providerSessionId: PROVIDER_SESSION_ID,
      turnId,
      event: {
        subtype: 'task_updated',
        task_id: TASK_ID,
        patch: { is_backgrounded: true, status: 'running' },
      },
    });
  }

  it('recovers instance A through one native SendMessage dispatch on instance B', async () => {
    await writeTranscriptFixture();
    const instanceA = coordinator('provider-a');
    await recordRunningBackgroundAgent(instanceA);

    const instanceB = coordinator('provider-b');
    const recovery = await instanceB.claimResumeDispatches({
      sessionId: SESSION_ID,
      workspacePath: WORKSPACE_PATH,
      providerSessionId: PROVIDER_SESSION_ID,
      turnId: 'provider-b:turn-1',
      isResume: true,
    });

    expect(recovery.dispatches).toHaveLength(1);
    expect(recovery.dispatches[0]).toMatchObject({
      taskId: TASK_ID,
      agentId: AGENT_ID,
      providerSessionId: PROVIDER_SESSION_ID,
      recipient: AGENT_ID,
      priorState: 'running',
    });
    expect(recovery.dispatches[0].transcript.relativePath).toBe(
      `${encodeClaudeWorkspaceDir(
        WORKSPACE_PATH
      )}/${PROVIDER_SESSION_ID}/subagents/agent-${AGENT_ID}.jsonl`
    );

    const preTool = await instanceB.guardNativeSendMessage({
      sessionId: SESSION_ID,
      turnId: 'provider-b:turn-1',
      toolUseId: 'send-recovery-1',
      input: { to: AGENT_ID, summary: 'Continue original source inspection' },
    });
    expect(preTool).toEqual(
      expect.objectContaining({ matched: true, allow: true })
    );

    await instanceB.observeNativeSendMessageResult({
      sessionId: SESSION_ID,
      turnId: 'provider-b:turn-1',
      toolUseId: 'send-recovery-1',
      isError: false,
      content: 'Message delivered',
    });

    const session = sessions.get(SESSION_ID)!;
    const ledger = getBackgroundAgentRecoveryLedger(session.metadata);
    expect(Object.values(ledger.tasks)).toEqual([
      expect.objectContaining({
        taskId: TASK_ID,
        agentId: AGENT_ID,
        recoveryState: 'dispatched',
        dispatchToolUseId: 'send-recovery-1',
      }),
    ]);
    expect(session.metadata.unrelatedLifecycleMetadata).toEqual({ keep: true });

    const sameTurnDuplicate = await instanceB.guardNativeSendMessage({
      sessionId: SESSION_ID,
      turnId: 'provider-b:turn-1',
      toolUseId: 'duplicate-after-success',
      input: { to: AGENT_ID, summary: 'Do not send a duplicate' },
    });
    expect(sameTurnDuplicate).toEqual(
      expect.objectContaining({ matched: true, allow: false })
    );

    const laterOrdinaryMessage = await instanceB.guardNativeSendMessage({
      sessionId: SESSION_ID,
      turnId: 'provider-b:turn-2',
      toolUseId: 'ordinary-after-auto',
      input: { to: AGENT_ID, summary: 'A later ordinary message' },
    });
    expect(laterOrdinaryMessage).toEqual({ matched: false, allow: true });
  });

  it('targets the original task and transcript instead of reconstructing an agent from summary text', async () => {
    await writeTranscriptFixture();
    const instanceA = coordinator('provider-a');
    await recordRunningBackgroundAgent(instanceA);

    const recovery = await coordinator('provider-b').claimResumeDispatches({
      sessionId: SESSION_ID,
      workspacePath: WORKSPACE_PATH,
      providerSessionId: PROVIDER_SESSION_ID,
      turnId: 'provider-b:turn-1',
      isResume: true,
    });
    const instruction = buildBackgroundAgentRecoveryInstruction(
      recovery.dispatches,
      recovery.notices
    );

    expect(instruction).toContain('SendMessage');
    expect(instruction).toContain(TASK_ID);
    expect(instruction).toContain(AGENT_ID);
    expect(instruction).toContain(`to: '${AGENT_ID}'`);
    expect(instruction).toContain('surviving transcript');
    expect(instruction).toContain('Do not launch a replacement Agent');
    expect(instruction).not.toContain('still working');
  });

  it('rejects terminal and mismatched transcript provenance before claiming recovery', async () => {
    await writeTranscriptFixture({ terminalStatus: 'completed' });
    await expect(
      inspectClaudeBackgroundAgentTranscript({
        projectsDir,
        workspacePath: WORKSPACE_PATH,
        providerSessionId: PROVIDER_SESSION_ID,
        agentId: AGENT_ID,
      })
    ).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        reason: 'terminal-subagent-transcript',
        terminalStatus: 'completed',
      })
    );

    await writeTranscriptFixture({ sidecarEntryAgentId: 'different-agent' });
    await expect(
      inspectClaudeBackgroundAgentTranscript({
        projectsDir,
        workspacePath: WORKSPACE_PATH,
        providerSessionId: PROVIDER_SESSION_ID,
        agentId: AGENT_ID,
      })
    ).resolves.toEqual({ ok: false, reason: 'mismatched-subagent-transcript' });

    await writeTranscriptFixture({
      parentEntrySessionId: 'different-provider-session',
    });
    await expect(
      inspectClaudeBackgroundAgentTranscript({
        projectsDir,
        workspacePath: WORKSPACE_PATH,
        providerSessionId: PROVIDER_SESSION_ID,
        agentId: AGENT_ID,
      })
    ).resolves.toEqual({ ok: false, reason: 'mismatched-parent-transcript' });
  });

  it('revalidates transcript state immediately before the native dispatch', async () => {
    await writeTranscriptFixture();
    const instanceA = coordinator('provider-a');
    await recordRunningBackgroundAgent(instanceA);
    const instanceB = coordinator('provider-b');
    await instanceB.claimResumeDispatches({
      sessionId: SESSION_ID,
      workspacePath: WORKSPACE_PATH,
      providerSessionId: PROVIDER_SESSION_ID,
      turnId: 'provider-b:turn-1',
      isResume: true,
    });

    await writeTranscriptFixture({ terminalStatus: 'completed' });
    await expect(
      instanceB.guardNativeSendMessage({
        sessionId: SESSION_ID,
        turnId: 'provider-b:turn-1',
        toolUseId: 'send-after-terminal',
        input: { to: AGENT_ID, summary: 'Do not dispatch after completion' },
      })
    ).resolves.toEqual(
      expect.objectContaining({
        matched: true,
        allow: false,
        reason: 'terminal-subagent-transcript',
      })
    );

    const record = Object.values(
      getBackgroundAgentRecoveryLedger(sessions.get(SESSION_ID)!.metadata).tasks
    )[0];
    expect(record.recoveryState).toBe('completed');
  });

  it('deduplicates concurrent checks, repeated init events, replayed task events, and a third process', async () => {
    await writeTranscriptFixture();
    const instanceA = coordinator('provider-a');
    await recordRunningBackgroundAgent(instanceA);

    const instanceB = coordinator('provider-b');
    const [first, concurrent, repeated] = await Promise.all([
      instanceB.claimResumeDispatches({
        sessionId: SESSION_ID,
        workspacePath: WORKSPACE_PATH,
        providerSessionId: PROVIDER_SESSION_ID,
        turnId: 'provider-b:turn-1',
        isResume: true,
      }),
      coordinator('provider-c').claimResumeDispatches({
        sessionId: SESSION_ID,
        workspacePath: WORKSPACE_PATH,
        providerSessionId: PROVIDER_SESSION_ID,
        turnId: 'provider-c:turn-1',
        isResume: true,
      }),
      instanceB.claimResumeDispatches({
        sessionId: SESSION_ID,
        workspacePath: WORKSPACE_PATH,
        providerSessionId: PROVIDER_SESSION_ID,
        turnId: 'provider-b:turn-1',
        isResume: true,
      }),
    ]);
    expect(
      first.dispatches.length +
        concurrent.dispatches.length +
        repeated.dispatches.length
    ).toBe(1);

    await instanceB.guardNativeSendMessage({
      sessionId: SESSION_ID,
      turnId: 'provider-b:turn-1',
      toolUseId: 'send-recovery-1',
      input: { to: AGENT_ID, summary: 'Continue original task' },
    });
    await instanceB.observeNativeSendMessageResult({
      sessionId: SESSION_ID,
      turnId: 'provider-b:turn-1',
      toolUseId: 'send-recovery-1',
      isError: false,
      content: 'ok',
    });

    // Replay of the original SDK event does not create a new recovery generation.
    await recordRunningBackgroundAgent(instanceA);
    const instanceC = coordinator('provider-c');
    const thirdProcess = await instanceC.claimResumeDispatches({
      sessionId: SESSION_ID,
      workspacePath: WORKSPACE_PATH,
      providerSessionId: PROVIDER_SESSION_ID,
      turnId: 'provider-c:turn-1',
      isResume: true,
    });
    expect(thirdProcess.dispatches).toEqual([]);
  });

  it('reclaims an expired claim that never reached the native send guard', async () => {
    await writeTranscriptFixture();
    const instanceA = coordinator('provider-a');
    await recordRunningBackgroundAgent(instanceA);

    const abandoned = await coordinator('provider-b').claimResumeDispatches({
      sessionId: SESSION_ID,
      workspacePath: WORKSPACE_PATH,
      providerSessionId: PROVIDER_SESSION_ID,
      turnId: 'provider-b:turn-1',
      isResume: true,
    });
    expect(abandoned.dispatches).toHaveLength(1);

    const beforeLeaseExpiry = await coordinator(
      'provider-c'
    ).claimResumeDispatches({
      sessionId: SESSION_ID,
      workspacePath: WORKSPACE_PATH,
      providerSessionId: PROVIDER_SESSION_ID,
      turnId: 'provider-c:turn-1',
      isResume: true,
    });
    expect(beforeLeaseExpiry.dispatches).toEqual([]);

    clock += 30_001;
    const afterLeaseExpiry = await coordinator(
      'provider-c'
    ).claimResumeDispatches({
      sessionId: SESSION_ID,
      workspacePath: WORKSPACE_PATH,
      providerSessionId: PROVIDER_SESSION_ID,
      turnId: 'provider-c:turn-2',
      isResume: true,
    });
    expect(afterLeaseExpiry.dispatches).toHaveLength(1);
    expect(afterLeaseExpiry.dispatches[0]?.generation).toBe(
      abandoned.dispatches[0]?.generation
    );
  });

  it('never auto-dispatches a generation after the native send guard persisted an ambiguous dispatch', async () => {
    await writeTranscriptFixture();
    const instanceA = coordinator('provider-a');
    await recordRunningBackgroundAgent(instanceA);

    const instanceB = coordinator('provider-b');
    const recovery = await instanceB.claimResumeDispatches({
      sessionId: SESSION_ID,
      workspacePath: WORKSPACE_PATH,
      providerSessionId: PROVIDER_SESSION_ID,
      turnId: 'provider-b:turn-1',
      isResume: true,
    });
    expect(recovery.dispatches).toHaveLength(1);
    await expect(
      instanceB.guardNativeSendMessage({
        sessionId: SESSION_ID,
        turnId: 'provider-b:turn-1',
        toolUseId: 'send-before-process-crash',
        input: { to: AGENT_ID, summary: 'Continue the original task' },
        plannedGenerations: recovery.dispatches.map(
          (dispatch) => dispatch.generation
        ),
      })
    ).resolves.toEqual(expect.objectContaining({ matched: true, allow: true }));

    // The native send may have happened, but process B dies before it can
    // persist the tool result or run turn finalization.
    clock += 5 * 60_000 + 1;
    const laterProcess = await coordinator(
      'provider-c'
    ).claimResumeDispatches({
      sessionId: SESSION_ID,
      workspacePath: WORKSPACE_PATH,
      providerSessionId: PROVIDER_SESSION_ID,
      turnId: 'provider-c:turn-1',
      isResume: true,
    });

    expect(laterProcess.dispatches).toEqual([]);
    expect(laterProcess.notices).toEqual([
      expect.objectContaining({
        generation: recovery.dispatches[0]?.generation,
        reason: 'ambiguous-dispatch',
      }),
    ]);
    expect(
      Object.values(
        getBackgroundAgentRecoveryLedger(sessions.get(SESSION_ID)!.metadata)
          .tasks
      )[0]
    ).toEqual(
      expect.objectContaining({
        recoveryState: 'notify-only',
        lastReason: 'ambiguous-dispatch',
        dispatchToolUseId: 'send-before-process-crash',
      })
    );
  });

  it('fails closed when a claimed recovery session is deleted before the native tool hook', async () => {
    await writeTranscriptFixture();
    await recordRunningBackgroundAgent(coordinator('provider-a'));
    const instanceB = coordinator('provider-b');
    const recovery = await instanceB.claimResumeDispatches({
      sessionId: SESSION_ID,
      workspacePath: WORKSPACE_PATH,
      providerSessionId: PROVIDER_SESSION_ID,
      turnId: 'provider-b:turn-1',
      isResume: true,
    });
    expect(recovery.dispatches).toHaveLength(1);

    sessions.delete(SESSION_ID);
    await expect(
      instanceB.guardNativeSendMessage({
        sessionId: SESSION_ID,
        turnId: 'provider-b:turn-1',
        toolUseId: 'send-after-session-delete',
        input: { to: AGENT_ID, summary: 'Must not leave deleted session' },
        plannedGenerations: recovery.dispatches.map(
          (dispatch) => dispatch.generation
        ),
      })
    ).resolves.toEqual({
      matched: true,
      allow: false,
      reason: 'background-agent-recovery-session-missing',
    });
  });

  it('lets the first manual or automatic resume win without blocking later ordinary messages', async () => {
    await writeTranscriptFixture();
    const instanceA = coordinator('provider-a');
    await recordRunningBackgroundAgent(instanceA);
    const instanceB = coordinator('provider-b');
    await instanceB.claimResumeDispatches({
      sessionId: SESSION_ID,
      workspacePath: WORKSPACE_PATH,
      providerSessionId: PROVIDER_SESSION_ID,
      turnId: 'provider-b:turn-1',
      isResume: true,
    });

    const manualWinner = await coordinator('provider-c').guardNativeSendMessage(
      {
        sessionId: SESSION_ID,
        turnId: 'provider-c:turn-1',
        toolUseId: 'manual-send',
        input: {
          to: AGENT_ID,
          summary: 'User requested original continuation',
        },
      }
    );
    const automaticLoser = await instanceB.guardNativeSendMessage({
      sessionId: SESSION_ID,
      turnId: 'provider-b:turn-1',
      toolUseId: 'automatic-send',
      input: { to: AGENT_ID, summary: 'Automatic recovery retry' },
    });
    expect(manualWinner).toEqual(
      expect.objectContaining({ matched: true, allow: true })
    );
    expect(automaticLoser).toEqual(
      expect.objectContaining({ matched: true, allow: false })
    );

    await coordinator('provider-c').observeNativeSendMessageResult({
      sessionId: SESSION_ID,
      turnId: 'provider-c:turn-1',
      toolUseId: 'manual-send',
      isError: false,
      content: 'ok',
    });

    const laterOrdinaryMessage = await instanceB.guardNativeSendMessage({
      sessionId: SESSION_ID,
      turnId: 'provider-b:turn-2',
      toolUseId: 'ordinary-send',
      input: { to: AGENT_ID, summary: 'A later ordinary message' },
    });
    expect(laterOrdinaryMessage).toEqual({ matched: false, allow: true });
  });

  it('never dispatches terminal, explicitly stopped, fresh, missing, mismatched, or malformed records', async () => {
    await writeTranscriptFixture();

    for (const status of ['completed', 'failed', 'stopped'] as const) {
      const sessionId = `terminal-${status}`;
      sessions.set(sessionId, {
        ...clone(sessions.get(SESSION_ID)!),
        id: sessionId,
        metadata: {},
      });
      const owner = coordinator(`owner-${status}`);
      await owner.observeTaskEvent({
        sessionId,
        workspacePath: WORKSPACE_PATH,
        providerSessionId: PROVIDER_SESSION_ID,
        turnId: `owner-${status}:turn-1`,
        launch: { runInBackground: true },
        event: {
          subtype: 'task_started',
          task_id: TASK_ID,
          tool_use_id: AGENT_ID,
          task_type: 'local_agent',
          description: 'terminal fixture',
        },
      });
      await owner.observeTaskEvent({
        sessionId,
        workspacePath: WORKSPACE_PATH,
        providerSessionId: PROVIDER_SESSION_ID,
        turnId: `owner-${status}:turn-1`,
        event: { subtype: 'task_notification', task_id: TASK_ID, status },
      });
      const result = await coordinator(
        `resume-${status}`
      ).claimResumeDispatches({
        sessionId,
        workspacePath: WORKSPACE_PATH,
        providerSessionId: PROVIDER_SESSION_ID,
        turnId: `resume-${status}:turn-1`,
        isResume: true,
      });
      expect(result.dispatches, status).toEqual([]);
    }

    const cancelledSession = 'explicitly-cancelled';
    sessions.set(cancelledSession, {
      ...clone(sessions.get(SESSION_ID)!),
      id: cancelledSession,
      metadata: {},
    });
    const cancelledOwner = coordinator('cancel-owner');
    await cancelledOwner.observeTaskEvent({
      sessionId: cancelledSession,
      workspacePath: WORKSPACE_PATH,
      providerSessionId: PROVIDER_SESSION_ID,
      turnId: 'cancel-owner:turn-1',
      launch: { runInBackground: true },
      event: {
        subtype: 'task_started',
        task_id: TASK_ID,
        tool_use_id: AGENT_ID,
        task_type: 'local_agent',
        description: 'cancel fixture',
      },
    });
    await cancelledOwner.suppressRunning(cancelledSession, 'user-cancelled');
    expect(
      (
        await coordinator('cancel-resume').claimResumeDispatches({
          sessionId: cancelledSession,
          workspacePath: WORKSPACE_PATH,
          providerSessionId: PROVIDER_SESSION_ID,
          turnId: 'cancel-resume:turn-1',
          isResume: true,
        })
      ).dispatches
    ).toEqual([]);

    const missingSession = 'missing-transcript';
    sessions.set(missingSession, {
      ...clone(sessions.get(SESSION_ID)!),
      id: missingSession,
      metadata: {},
    });
    const missingOwner = coordinator('missing-owner');
    await missingOwner.observeTaskEvent({
      sessionId: missingSession,
      workspacePath: WORKSPACE_PATH,
      providerSessionId: PROVIDER_SESSION_ID,
      turnId: 'missing-owner:turn-1',
      launch: { runInBackground: true },
      event: {
        subtype: 'task_started',
        task_id: 'missing-task',
        tool_use_id: 'missing-agent',
        task_type: 'local_agent',
        description: 'missing fixture',
      },
    });
    const missing = await coordinator('missing-resume').claimResumeDispatches({
      sessionId: missingSession,
      workspacePath: WORKSPACE_PATH,
      providerSessionId: PROVIDER_SESSION_ID,
      turnId: 'missing-resume:turn-1',
      isResume: true,
    });
    expect(missing.dispatches).toEqual([]);
    expect(missing.notices[0]?.reason).toBe('missing-subagent-transcript');

    await recordRunningBackgroundAgent(
      coordinator('fresh-owner'),
      'fresh-owner:turn-1'
    );
    const fresh = await coordinator('fresh').claimResumeDispatches({
      sessionId: SESSION_ID,
      workspacePath: WORKSPACE_PATH,
      providerSessionId: undefined,
      turnId: 'fresh:turn-1',
      isResume: false,
    });
    expect(fresh.dispatches).toEqual([]);
    expect(
      Object.values(
        getBackgroundAgentRecoveryLedger(sessions.get(SESSION_ID)!.metadata)
          .tasks
      )[0]
    ).toEqual(
      expect.objectContaining({
        recoveryState: 'notify-only',
        lastReason: 'non-resume-start',
      })
    );

    const mismatchedSession = 'mismatched-provider-session';
    sessions.set(mismatchedSession, {
      ...clone(sessions.get(SESSION_ID)!),
      id: mismatchedSession,
      metadata: {},
    });
    await recordRunningBackgroundAgent(
      coordinator('mismatched-owner'),
      'mismatched-owner:turn-1',
      mismatchedSession
    );
    const mismatched = await coordinator('mismatched').claimResumeDispatches({
      sessionId: mismatchedSession,
      workspacePath: WORKSPACE_PATH,
      providerSessionId: 'different-provider-session',
      turnId: 'mismatched:turn-1',
      isResume: true,
    });
    expect(mismatched.dispatches).toEqual([]);
    expect(
      Object.values(
        getBackgroundAgentRecoveryLedger(
          sessions.get(mismatchedSession)!.metadata
        ).tasks
      )[0]
    ).toEqual(
      expect.objectContaining({
        recoveryState: 'notify-only',
        lastReason: 'unverified-provider-session',
      })
    );

    const malformedSession = sessions.get(SESSION_ID)!;
    malformedSession.metadata = {
      backgroundAgentRecovery: 'legacy-corrupt-value',
      currentTasks: [{ taskId: 'legacy-task', status: 'running' }],
    };
    const malformed = await coordinator('malformed').claimResumeDispatches({
      sessionId: SESSION_ID,
      workspacePath: WORKSPACE_PATH,
      providerSessionId: PROVIDER_SESSION_ID,
      turnId: 'malformed:turn-1',
      isResume: true,
    });
    expect(malformed.dispatches).toEqual([]);
    expect(
      (sessions.get(SESSION_ID)!.metadata.currentTasks as any[])[0].status
    ).toBe('stopped');
  });

  it('keeps a rejected dispatch retryable once, then records an ambiguous dispatch without false running state', async () => {
    await writeTranscriptFixture();
    const instanceA = coordinator('provider-a');
    await recordRunningBackgroundAgent(instanceA);

    const instanceB = coordinator('provider-b');
    const firstAttempt = await instanceB.claimResumeDispatches({
      sessionId: SESSION_ID,
      workspacePath: WORKSPACE_PATH,
      providerSessionId: PROVIDER_SESSION_ID,
      turnId: 'provider-b:turn-1',
      isResume: true,
    });
    expect(firstAttempt.dispatches).toHaveLength(1);
    await instanceB.guardNativeSendMessage({
      sessionId: SESSION_ID,
      turnId: 'provider-b:turn-1',
      toolUseId: 'send-rejected',
      input: { to: AGENT_ID, summary: 'Continue original task' },
    });
    await instanceB.observeNativeSendMessageResult({
      sessionId: SESSION_ID,
      turnId: 'provider-b:turn-1',
      toolUseId: 'send-rejected',
      isError: true,
      content: 'native dispatch rejected',
    });
    await expect(
      instanceB.guardNativeSendMessage({
        sessionId: SESSION_ID,
        turnId: 'provider-b:turn-1',
        toolUseId: 'same-turn-retry',
        input: { to: AGENT_ID, summary: 'Do not send this duplicate' },
      })
    ).resolves.toEqual(
      expect.objectContaining({ matched: true, allow: false })
    );

    const providerC = coordinator('provider-c');
    const retry = await providerC.claimResumeDispatches({
      sessionId: SESSION_ID,
      workspacePath: WORKSPACE_PATH,
      providerSessionId: PROVIDER_SESSION_ID,
      turnId: 'provider-c:turn-1',
      isResume: true,
    });
    expect(retry.dispatches).toHaveLength(1);
    await expect(
      providerC.guardNativeSendMessage({
        sessionId: SESSION_ID,
        turnId: 'provider-c:turn-1',
        toolUseId: 'send-retry',
        input: { to: AGENT_ID, summary: 'Retry original task continuation' },
      })
    ).resolves.toEqual(expect.objectContaining({ matched: true, allow: true }));
    await providerC.finishRecoveryTurn({
      sessionId: SESSION_ID,
      turnId: 'provider-c:turn-1',
      plannedGenerations: retry.dispatches.map(
        (dispatch) => dispatch.generation
      ),
    });

    const ledger = getBackgroundAgentRecoveryLedger(
      sessions.get(SESSION_ID)!.metadata
    );
    expect(Object.values(ledger.tasks)[0]).toEqual(
      expect.objectContaining({
        recoveryState: 'notify-only',
        lastReason: 'ambiguous-dispatch',
      })
    );
    expect(
      (sessions.get(SESSION_ID)!.metadata.currentTasks as any[])[0].status
    ).toBe('stopped');
  });

  it('does not let a late native result override explicit cancellation', async () => {
    await writeTranscriptFixture();
    const instanceA = coordinator('provider-a');
    await recordRunningBackgroundAgent(instanceA);
    const instanceB = coordinator('provider-b');
    await instanceB.claimResumeDispatches({
      sessionId: SESSION_ID,
      workspacePath: WORKSPACE_PATH,
      providerSessionId: PROVIDER_SESSION_ID,
      turnId: 'provider-b:turn-1',
      isResume: true,
    });
    await instanceB.guardNativeSendMessage({
      sessionId: SESSION_ID,
      turnId: 'provider-b:turn-1',
      toolUseId: 'send-before-cancel',
      input: { to: AGENT_ID, summary: 'Continue original task' },
    });

    await instanceB.suppressRunning(SESSION_ID, 'user-cancelled');
    await instanceB.observeNativeSendMessageResult({
      sessionId: SESSION_ID,
      turnId: 'provider-b:turn-1',
      toolUseId: 'send-before-cancel',
      isError: false,
      content: 'late success',
    });
    await instanceB.observeTaskEvent({
      sessionId: SESSION_ID,
      workspacePath: WORKSPACE_PATH,
      providerSessionId: PROVIDER_SESSION_ID,
      turnId: 'provider-b:turn-1',
      launch: { runInBackground: true, name: 'researcher' },
      event: {
        subtype: 'task_started',
        task_id: TASK_ID,
        tool_use_id: AGENT_ID,
        task_type: 'local_agent',
        description: 'late cancelled replay',
      },
    });

    const record = Object.values(
      getBackgroundAgentRecoveryLedger(sessions.get(SESSION_ID)!.metadata).tasks
    )[0];
    expect(record).toEqual(
      expect.objectContaining({
        recoveryState: 'cancelled',
        lastReason: 'user-cancelled',
      })
    );
    expect(
      (sessions.get(SESSION_ID)!.metadata.currentTasks as any[])[0].status
    ).toBe('stopped');
  });

  it('persists an explicit TaskStop for a ledger-known task after provider recycle', async () => {
    await writeTranscriptFixture();
    await recordRunningBackgroundAgent(coordinator('provider-a'));
    const recycledProvider = coordinator('provider-b');
    const recovery = await recycledProvider.claimResumeDispatches({
      sessionId: SESSION_ID,
      workspacePath: WORKSPACE_PATH,
      providerSessionId: PROVIDER_SESSION_ID,
      turnId: 'provider-b:turn-1',
      isResume: true,
    });
    expect(recovery.dispatches).toHaveLength(1);

    await expect(
      recycledProvider.observeExplicitTaskStop({
        sessionId: SESSION_ID,
        taskId: TASK_ID,
      })
    ).resolves.toBe(true);

    const session = sessions.get(SESSION_ID)!;
    expect(
      Object.values(getBackgroundAgentRecoveryLedger(session.metadata).tasks)[0]
    ).toEqual(
      expect.objectContaining({
        recoveryState: 'stopped',
        lastReason: 'native-task-stop-succeeded',
      })
    );
    expect(session.metadata.currentTasks).toEqual([
      expect.objectContaining({
        taskId: TASK_ID,
        status: 'stopped',
        recoveryDisposition: 'native-task-stop-succeeded',
      }),
    ]);

    const nextProcess = await coordinator('provider-c').claimResumeDispatches({
      sessionId: SESSION_ID,
      workspacePath: WORKSPACE_PATH,
      providerSessionId: PROVIDER_SESSION_ID,
      turnId: 'provider-c:turn-1',
      isResume: true,
    });
    expect(nextProcess.dispatches).toEqual([]);
  });

  it('dispatches each recovered-running generation once while same-generation replay stays at zero', async () => {
    await writeTranscriptFixture();
    const instanceA = coordinator('provider-a');
    await recordRunningBackgroundAgent(instanceA);
    const instanceB = coordinator('provider-b');
    await instanceB.claimResumeDispatches({
      sessionId: SESSION_ID,
      workspacePath: WORKSPACE_PATH,
      providerSessionId: PROVIDER_SESSION_ID,
      turnId: 'provider-b:turn-1',
      isResume: true,
    });
    await instanceB.guardNativeSendMessage({
      sessionId: SESSION_ID,
      turnId: 'provider-b:turn-1',
      toolUseId: 'send-recovery-1',
      input: { to: AGENT_ID, summary: 'Continue original task' },
    });
    await instanceB.observeNativeSendMessageResult({
      sessionId: SESSION_ID,
      turnId: 'provider-b:turn-1',
      toolUseId: 'send-recovery-1',
      isError: false,
      content: 'ok',
    });

    await instanceB.observeTaskEvent({
      sessionId: SESSION_ID,
      workspacePath: WORKSPACE_PATH,
      providerSessionId: PROVIDER_SESSION_ID,
      turnId: 'provider-b:turn-1',
      launch: { runInBackground: true, name: 'researcher' },
      event: {
        subtype: 'task_started',
        task_id: TASK_ID,
        tool_use_id: AGENT_ID,
        task_type: 'local_agent',
        description: 'Inspect the original source',
      },
    });

    const ledger = getBackgroundAgentRecoveryLedger(
      sessions.get(SESSION_ID)!.metadata
    );
    const records = Object.values(ledger.tasks).sort(
      (a, b) => a.generationNumber - b.generationNumber
    );
    expect(records).toHaveLength(2);
    expect(records.map((record) => record.generationNumber)).toEqual([1, 2]);
    expect(records[1]).toEqual(
      expect.objectContaining({
        sourceTurnId: 'provider-b:turn-1',
        recoveryState: 'pending',
        priorState: 'running',
      })
    );

    // Replay of the recovered-running event is still generation 2, not a new
    // candidate, and the next provider process dispatches that generation once.
    await instanceB.observeTaskEvent({
      sessionId: SESSION_ID,
      workspacePath: WORKSPACE_PATH,
      providerSessionId: PROVIDER_SESSION_ID,
      turnId: 'provider-b:turn-1',
      launch: { runInBackground: true, name: 'researcher' },
      event: {
        subtype: 'task_started',
        task_id: TASK_ID,
        tool_use_id: AGENT_ID,
        task_type: 'local_agent',
        description: 'Inspect the original source',
      },
    });
    expect(
      Object.values(
        getBackgroundAgentRecoveryLedger(sessions.get(SESSION_ID)!.metadata)
          .tasks
      )
    ).toHaveLength(2);

    const instanceC = coordinator('provider-c');
    const secondGeneration = await instanceC.claimResumeDispatches({
      sessionId: SESSION_ID,
      workspacePath: WORKSPACE_PATH,
      providerSessionId: PROVIDER_SESSION_ID,
      turnId: 'provider-c:turn-1',
      isResume: true,
    });
    expect(secondGeneration.dispatches).toHaveLength(1);
    expect(secondGeneration.dispatches[0]?.generation).toBe(
      records[1]?.generation
    );
    await expect(
      instanceC.guardNativeSendMessage({
        sessionId: SESSION_ID,
        turnId: 'provider-c:turn-1',
        toolUseId: 'send-recovery-2',
        input: { to: AGENT_ID, summary: 'Continue recovered running work' },
        plannedGenerations: secondGeneration.dispatches.map(
          (dispatch) => dispatch.generation
        ),
      })
    ).resolves.toEqual(expect.objectContaining({ matched: true, allow: true }));
    await instanceC.observeNativeSendMessageResult({
      sessionId: SESSION_ID,
      turnId: 'provider-c:turn-1',
      toolUseId: 'send-recovery-2',
      isError: false,
      content: 'ok',
    });

    const repeatedProcess = await coordinator(
      'provider-d'
    ).claimResumeDispatches({
      sessionId: SESSION_ID,
      workspacePath: WORKSPACE_PATH,
      providerSessionId: PROVIDER_SESSION_ID,
      turnId: 'provider-d:turn-1',
      isResume: true,
    });
    expect(repeatedProcess.dispatches).toEqual([]);
    expect(
      Object.values(
        getBackgroundAgentRecoveryLedger(sessions.get(SESSION_ID)!.metadata)
          .tasks
      )
        .sort((a, b) => a.generationNumber - b.generationNumber)
        .map((record) => record.recoveryState)
    ).toEqual(['dispatched', 'dispatched']);
  });
});
