/**
 * NIM-806 Phase 3 (B3) — scenario-cycling integration test for the genuine
 * `claude-code-cli` observation→render pipeline, driven END-TO-END through the
 * REAL units with a FAKE Anthropic upstream emitting canned SSE. No billing, no
 * real `claude` process, no /restart, no UI clicks.
 *
 * The pipeline under test (all real, only the Anthropic SSE bytes + the on-disk
 * DB row are faked):
 *
 *   fake upstream (canned SSE)
 *     → ClaudeCliProxyObservation (real loopback proxy + SSE tee)
 *       → ClaudeApiMessageAssembler (real reassembly)
 *         → buildAssistantRawContent (real bridge → ai_agent_messages row shape)
 *           → projectRawMessagesToViewMessages (the REAL renderer projector)
 *             → assert the rendered widget
 *
 * Scenarios (each an `it`):
 *   1. AskUserQuestion turn  → exactly ONE answerable widget, ordered AFTER its
 *      text (regression for the ordering-inversion + duplicate fix: the synthetic
 *      nimbalyst_tool_use row is gone; the proxy turn's tool_use block drives it).
 *   2. Answer settles        → appending the settle tool_result flips the SAME
 *      widget to answered (no second widget).
 *   3. PromptForUserInput     → same pipeline renders the RequestUserInput widget,
 *      ordered after its text (the identical fix on the sibling handler).
 *   4. Rate limit (429)       → onRateLimit fires and the 429 is forwarded to the
 *      caller (so the CLI can back off) — the "paused, not hung" signal source.
 *   5. Keep-alive             → two sequential turns reuse ONE upstream connection
 *      (regression for the startup-429 cold-connection-burst fix).
 */

import * as http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeCliProxyObservation } from '../claudeCliProxyObservation';
import type { AssembledAssistantMessage } from '../claudeApiMessageAssembler';
import { buildAssistantRawContent } from '../claudeCliTranscriptBridge';
import { buildInteractivePromptToolResultContent } from '../../../../mcp/tools/interactivePromptTranscript';
import { projectRawMessagesToViewMessages } from '@nimbalyst/runtime/ai/server/transcript';
import type { RawMessage } from '@nimbalyst/runtime/ai/server/transcript';

// ---------------------------------------------------------------------------
// Canned Anthropic SSE helpers
// ---------------------------------------------------------------------------
function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** A whole assistant turn: one text block followed by one tool_use block. */
function turnWithToolUse(args: {
  msgId: string;
  text: string;
  toolId: string;
  toolName: string;
  input: unknown;
}): string {
  return (
    sse('message_start', {
      type: 'message_start',
      message: { id: args.msgId, model: 'claude-opus-4-8', usage: { input_tokens: 10, output_tokens: 0 } },
    }) +
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: args.text } }) +
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }) +
    sse('content_block_start', {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: args.toolId, name: args.toolName, input: {} },
    }) +
    // tool_use input streams as input_json_delta and is reassembled on stop.
    sse('content_block_delta', {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(args.input) },
    }) +
    sse('content_block_stop', { type: 'content_block_stop', index: 1 }) +
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } }) +
    sse('message_stop', { type: 'message_stop' })
  );
}

interface FakeUpstream {
  url: string;
  close: () => Promise<void>;
  connectionCount: () => number;
}

/**
 * Fake Anthropic. `status:429` simulates a rate limit; otherwise it streams the
 * next canned turn for each request (last one repeats).
 */
function startFakeAnthropic(opts: { turns?: string[]; status?: number }): Promise<FakeUpstream> {
  let connections = 0;
  let reqIndex = 0;
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        if (opts.status === 429) {
          res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '5' });
          res.end(JSON.stringify({ error: { type: 'rate_limit_error', message: 'slow down' } }));
          return;
        }
        const turns = opts.turns ?? [];
        const body = turns[Math.min(reqIndex, turns.length - 1)] ?? '';
        reqIndex += 1;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(body);
        res.end();
      });
    });
    server.on('connection', () => {
      connections += 1;
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw new Error('no upstream addr');
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((r) => server.close(() => r())),
        connectionCount: () => connections,
      });
    });
  });
}

/** POST a normal (observed) /v1/messages turn to the proxy and resolve on completion. */
function postTurn(port: number): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: '/v1/messages', method: 'POST', headers: { 'content-type': 'application/json' } },
      (res) => {
        res.on('data', () => {});
        res.on('end', () => resolve({ status: res.statusCode || 0 }));
      },
    );
    req.on('error', reject);
    req.write(JSON.stringify({ model: 'claude-opus-4-8', messages: [{ role: 'user', content: 'go' }] }));
    req.end();
  });
}

function raw(content: string): RawMessage {
  return {
    id: Math.floor(Math.random() * 1e9),
    sessionId: 'cli-pipeline',
    source: 'claude-code',
    direction: 'output',
    content,
    createdAt: new Date('2026-06-09T00:00:00Z'),
  };
}

const QUESTIONS = [
  {
    header: 'Direction',
    question: 'How do you want to take this forward?',
    options: [
      { label: 'Keep building', description: 'Continue the work.' },
      { label: 'Stop here', description: 'Pause for review.' },
    ],
    multiSelect: false,
  },
];

describe('claude-code-cli observation pipeline (fake upstream, real units)', () => {
  let upstream: FakeUpstream | null = null;
  let obs: ClaudeCliProxyObservation | null = null;

  afterEach(async () => {
    if (obs) obs.stop();
    if (upstream) await upstream.close();
    obs = null;
    upstream = null;
  });

  /**
   * Drive ONE canned turn through the real proxy+assembler and return the rendered
   * view messages (proxy turn → bridge row → real projector), plus the assembled
   * message for direct assertions.
   */
  async function renderTurn(
    sessionId: string,
    extraRows: string[] = [],
  ): Promise<{ vms: any[]; assembled: AssembledAssistantMessage }> {
    const captured: AssembledAssistantMessage[] = [];
    obs = new ClaudeCliProxyObservation({
      sessionId,
      onAssistantMessage: (m) => captured.push(m),
      upstreamUrl: upstream!.url,
    });
    const { baseUrl } = await obs.start();
    await postTurn(Number(new URL(baseUrl).port));

    expect(captured).toHaveLength(1);
    const rows = [raw(buildAssistantRawContent(captured[0])), ...extraRows.map(raw)];
    const vms = await projectRawMessagesToViewMessages(rows, 'claude-code-cli');
    return { vms, assembled: captured[0] };
  }

  // -- Scenario 1 ----------------------------------------------------------
  it('AskUserQuestion turn renders exactly ONE answerable widget, ordered after its text', async () => {
    upstream = await startFakeAnthropic({
      turns: [
        turnWithToolUse({
          msgId: 'msg_auq',
          text: 'Here is my analysis. How do you want to take this forward?',
          toolId: 'toolu_auq_1',
          toolName: 'mcp__nimbalyst-mcp__AskUserQuestion',
          input: { questions: QUESTIONS },
        }),
      ],
    });

    const { vms } = await renderTurn('sess-auq');

    const isAuq = (m: any) => typeof m?.toolCall?.toolName === 'string' && m.toolCall.toolName.endsWith('AskUserQuestion');
    const widgets = vms.filter(isAuq);
    expect(widgets).toHaveLength(1); // no duplicate
    const toolCall = (widgets[0] as any).toolCall;
    expect(toolCall.providerToolCallId).toBe('toolu_auq_1'); // answer-channel key intact
    expect(toolCall.arguments.questions[0].question).toBe('How do you want to take this forward?');
    expect(toolCall.result == null || toolCall.result === '').toBe(true); // pending → answerable

    // Ordering: explanatory text BEFORE the question widget.
    const textIdx = vms.findIndex((m: any) => typeof m?.text === 'string' && m.text.includes('Here is my analysis'));
    const widgetIdx = vms.findIndex(isAuq);
    expect(textIdx).toBeGreaterThanOrEqual(0);
    expect(widgetIdx).toBeGreaterThan(textIdx);
  });

  // -- Scenario 2 ----------------------------------------------------------
  it('appending the settle tool_result flips the same widget to answered (no second widget)', async () => {
    upstream = await startFakeAnthropic({
      turns: [
        turnWithToolUse({
          msgId: 'msg_auq2',
          text: 'Analysis. How do you want to take this forward?',
          toolId: 'toolu_auq_2',
          toolName: 'mcp__nimbalyst-mcp__AskUserQuestion',
          input: { questions: QUESTIONS },
        }),
      ],
    });

    // The settle writes a tool_result keyed by the SAME tool id (real builder).
    const settleRow = buildInteractivePromptToolResultContent({
      toolUseId: 'toolu_auq_2',
      result: { answers: { 'How do you want to take this forward?': 'Keep building' }, cancelled: false },
      isError: false,
    });

    const { vms } = await renderTurn('sess-auq2', [settleRow]);

    const widgets = vms.filter((m: any) => typeof m?.toolCall?.toolName === 'string' && m.toolCall.toolName.endsWith('AskUserQuestion'));
    expect(widgets).toHaveLength(1); // still one widget, now completed
    const toolCall = (widgets[0] as any).toolCall;
    expect(toolCall.providerToolCallId).toBe('toolu_auq_2');
    expect(toolCall.result).toBeTruthy();
    expect(String(toolCall.result)).toContain('Keep building');
  });

  // -- Scenario 3 ----------------------------------------------------------
  it('PromptForUserInput turn renders the RequestUserInput widget, ordered after its text', async () => {
    upstream = await startFakeAnthropic({
      turns: [
        turnWithToolUse({
          msgId: 'msg_pfui',
          text: 'I need one detail before continuing.',
          toolId: 'toolu_pfui_1',
          toolName: 'mcp__nimbalyst-mcp__PromptForUserInput',
          input: { title: 'Detail', fields: [{ type: 'editText', key: 'name', label: 'Name' }] },
        }),
      ],
    });

    const { vms } = await renderTurn('sess-pfui');

    const isPrompt = (m: any) => typeof m?.toolCall?.toolName === 'string' && m.toolCall.toolName.endsWith('PromptForUserInput');
    const widgets = vms.filter(isPrompt);
    expect(widgets).toHaveLength(1);
    expect((widgets[0] as any).toolCall.providerToolCallId).toBe('toolu_pfui_1');

    const textIdx = vms.findIndex((m: any) => typeof m?.text === 'string' && m.text.includes('I need one detail'));
    const widgetIdx = vms.findIndex(isPrompt);
    expect(textIdx).toBeGreaterThanOrEqual(0);
    expect(widgetIdx).toBeGreaterThan(textIdx);
  });

  // -- Scenario 4 ----------------------------------------------------------
  it('rate-limit (429) fires onRateLimit and forwards the 429 so the CLI can back off', async () => {
    upstream = await startFakeAnthropic({ status: 429 });

    const rateLimits: Array<{ statusCode: number; retryAfter?: string }> = [];
    obs = new ClaudeCliProxyObservation({
      sessionId: 'sess-429',
      onAssistantMessage: () => {},
      onRateLimit: (info) => rateLimits.push(info),
      upstreamUrl: upstream.url,
    });
    const { baseUrl } = await obs.start();
    const res = await postTurn(Number(new URL(baseUrl).port));

    expect(res.status).toBe(429); // forwarded to the caller, not swallowed
    expect(rateLimits).toHaveLength(1);
    expect(rateLimits[0].statusCode).toBe(429);
    expect(rateLimits[0].retryAfter).toBe('5');
  });

  // -- Scenario 5 ----------------------------------------------------------
  it('reuses ONE upstream connection across two sequential turns (keep-alive, anti startup-429)', async () => {
    upstream = await startFakeAnthropic({
      turns: [
        turnWithToolUse({ msgId: 'msg_k1', text: 'one', toolId: 't1', toolName: 'mcp__nimbalyst-mcp__AskUserQuestion', input: { questions: QUESTIONS } }),
        turnWithToolUse({ msgId: 'msg_k2', text: 'two', toolId: 't2', toolName: 'mcp__nimbalyst-mcp__AskUserQuestion', input: { questions: QUESTIONS } }),
      ],
    });

    obs = new ClaudeCliProxyObservation({ sessionId: 'sess-keepalive', onAssistantMessage: () => {}, upstreamUrl: upstream.url });
    const { baseUrl } = await obs.start();
    const port = Number(new URL(baseUrl).port);

    await postTurn(port);
    await postTurn(port);

    expect(upstream.connectionCount()).toBe(1);
  });
});
