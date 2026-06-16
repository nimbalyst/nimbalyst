/**
 * NIM-806 Phase 3 (B3) — the single self-runnable reproduction of the genuine
 * `claude-code-cli` AskUserQuestion answer round-trip, WITHOUT a real model turn
 * (no billing, no UI clicks, no /restart). Drives the REAL units that the live
 * defects surface in, so the fixes are verifiable here repeatedly.
 *
 * Two defects, both surfacing only after the user answers a CLI AskUserQuestion
 * widget (the CLI then finishes the turn):
 *
 *   Defect A — stuck "running" indicator. The MCP interactive-prompt settle used
 *     to force SessionStateManager `running` on EVERY provider. For a CLI session
 *     the PID-state watcher owns running/idle, so settle's forced `running` races
 *     the watcher's turn-ending `idle` and SSM's supersede-guard drops the
 *     `session:completed` emit → the renderer never clears the indicator.
 *
 *   Defect B — duplicate `nimbalyst_tool_result`. Two writers persist a row for
 *     the same tool_use_id: the settle synthetic write AND the proxy request-body
 *     scrape. The proxy `seen` set is pre-seeded only at observation start, so it
 *     misses the mid-turn synthetic write → a second row.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Capture every ai_agent_messages row written by the REAL synthetic writer
// (persistInteractivePromptToolResult), which imports the runtime repository.
// ---------------------------------------------------------------------------
const createdRows: Array<{ content: string }> = [];
vi.mock('@nimbalyst/runtime', () => ({
  AgentMessagesRepository: {
    create: vi.fn(async (row: { content: string }) => {
      createdRows.push(row);
      return undefined;
    }),
  },
  AISessionsRepository: {
    get: vi.fn(async () => ({ provider: 'claude-code-cli' })),
  },
}));

import { SessionStateManager } from '@nimbalyst/runtime/ai/server/SessionStateManager';
import type { SessionStateEvent } from '@nimbalyst/runtime/ai/server/types/SessionState';
import { applyInteractivePromptSettleTurnState } from '../../../mcp/tools/interactivePromptSettleState';
import { persistInteractivePromptToolResult } from '../../../mcp/tools/interactivePromptTranscript';
import { logClaudeCliToolResults } from '../claudeCliToolResultLog';
import {
  getSeenToolResultIds,
  clearSeenToolResultIds,
} from '../claudeCliToolResultSeen';

beforeEach(() => {
  createdRows.length = 0;
});

describe('claude-code-cli AskUserQuestion answer round-trip', () => {
  // -------------------------------------------------------------------------
  // Defect A: after the user answers and the CLI finishes the turn, the session
  // must end in a TERMINAL `session:completed` (indicator cleared) — not stuck
  // on `session:streaming` (running). Reproduces the settle-vs-watcher race
  // against the REAL SessionStateManager.
  // -------------------------------------------------------------------------
  it('ends the turn in session:completed (indicator cleared) after answer + CLI idle', async () => {
    const sessionId = 'cli-session-A';
    const workspacePath = '/w';

    const sm = new SessionStateManager();
    // Fake DB worker: queries resolve on the microtask queue so the two
    // concurrent updateActivity calls below interleave exactly as they do in
    // production (each sets in-memory status synchronously, then awaits its DB
    // write) — the deterministic shape of the live race.
    sm.setDatabase({ query: async () => ({ rows: [] }) });

    const events: string[] = [];
    sm.subscribe((e: SessionStateEvent) => events.push(e.type));

    await sm.startSession({ sessionId, workspacePath, initialStatus: 'running' });
    // MCP AskUserQuestion start → waiting_for_input.
    await sm.updateActivity({ sessionId, status: 'waiting_for_input' });

    events.length = 0; // focus on the answer→turn-end transition

    // The user answers (interactive-prompt settle) AND the PID watcher reports
    // the CLI finished the turn (idle), racing. Fire both without awaiting in
    // between, exactly as the two independent main-process callers do.
    const pIdle = sm.updateActivity({ sessionId, status: 'idle', isStreaming: false });
    const pSettle = applyInteractivePromptSettleTurnState({
      sessionId,
      isCliSession: true,
      stateManager: sm,
    });
    await Promise.all([pIdle, pSettle]);

    // Invariant: a CLI session whose turn ended must broadcast session:completed
    // so the renderer clears sessionProcessingAtom. It must NOT be left asserting
    // session:streaming (running) as the surviving state.
    expect(events).toContain('session:completed');
    expect(events[events.length - 1]).toBe('session:completed');
    expect(events).not.toContain('session:streaming');
  });

  // -------------------------------------------------------------------------
  // Defect B: exactly ONE nimbalyst_tool_result row for the answered question,
  // even though the synthetic settle write AND the proxy request-body scrape
  // both fire for the same tool_use_id.
  // -------------------------------------------------------------------------
  it('persists exactly one tool_result row across the synthetic write and proxy scrape', async () => {
    const sessionId = 'cli-session-B';
    const workspacePath = '/w';
    const toolUseId = 'toolu_question_1';
    clearSeenToolResultIds(sessionId);

    // 1) Settle: the MCP handler writes the synthetic tool_result (real path).
    await persistInteractivePromptToolResult({
      sessionId,
      toolUseId,
      result: { answers: { Q: 'A' }, cancelled: false, respondedBy: 'desktop', respondedAt: 0 },
      isError: false,
    });

    // 2) Proxy: the CLI echoes the tool_result in its continuation request body;
    //    logClaudeCliToolResults scrapes it, using the shared per-session seen set
    //    (the same registry the proxy observation pre-seeds + the synthetic write
    //    marks).
    await logClaudeCliToolResults(
      {
        sessionId,
        workspacePath,
        results: [{ toolUseId, content: '{"answers":{"Q":"A"}}', isError: false }],
        seen: getSeenToolResultIds(sessionId),
      },
      {
        createMessage: vi.fn(async (row) => {
          createdRows.push({ content: row.content });
          return undefined;
        }),
        notifyMessageLogged: vi.fn(),
        now: () => new Date('2026-06-08T00:00:00.000Z'),
      },
    );

    const toolResultRows = createdRows.filter((r) => {
      try {
        const parsed = JSON.parse(r.content);
        return parsed?.type === 'nimbalyst_tool_result' && parsed?.tool_use_id === toolUseId;
      } catch {
        return false;
      }
    });
    expect(toolResultRows).toHaveLength(1);
  });
});
