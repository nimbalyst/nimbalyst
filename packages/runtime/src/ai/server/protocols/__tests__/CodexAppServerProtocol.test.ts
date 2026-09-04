// Unit tests for CodexAppServerProtocol against a mock JSON-RPC peer.
//
// We stub `child_process.spawn` so the protocol talks to a fake codex
// app-server we can drive frame-by-frame. This locks in the request/response
// shape and notification translation that future codex upgrades might break.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

// IMPORTANT: mock `node:child_process` BEFORE importing the protocol so the
// module under test picks up the stub.
const spawnMock = vi.fn();
const taskkillSpawnMock = vi.fn();
vi.mock('node:child_process', () => {
  const spawn = (...args: unknown[]) => args[0] === 'taskkill.exe'
    ? taskkillSpawnMock(...args)
    : spawnMock(...args);
  return { spawn, default: { spawn } };
});

// Stub binary resolution so we don't depend on @openai/codex being installed.
vi.mock('../codexAppServer/codexAppServerBinary', () => ({
  resolveCodexBinaryPath: () => '/fake/codex',
  resolveCodexBinaryFromModules: () => '/fake/codex',
  getCodexVendorPathEntries: () => [],
}));

import { CodexAppServerProtocol } from '../CodexAppServerProtocol';
import type { ProtocolEvent } from '../ProtocolInterface';

class FakeChildProcess extends EventEmitter {
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  killed = false;
  /** Captures every line the protocol writes to stdin. */
  readonly writtenLines: unknown[] = [];

  constructor() {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    let buffer = '';
    this.stdin.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue;
        try { this.writtenLines.push(JSON.parse(line)); }
        catch { this.writtenLines.push({ __unparseable: line }); }
      }
    });
  }

  kill(): boolean {
    if (this.killed) return false;
    this.killed = true;
    this.emit('exit', 0, null);
    return true;
  }

  /** Push a server -> client line. */
  emitLine(msg: unknown): void {
    this.stdout.write(JSON.stringify(msg) + '\n');
  }
}

function nextWrittenMatching(child: FakeChildProcess, method: string, timeoutMs = 1000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      for (const line of child.writtenLines) {
        if (line && typeof line === 'object' && (line as Record<string, unknown>).method === method) {
          resolve(line as Record<string, unknown>);
          return;
        }
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`timeout waiting for ${method}; saw: ${JSON.stringify(child.writtenLines)}`));
        return;
      }
      setTimeout(check, 5);
    };
    check();
  });
}

/** Wait for the client's response line to a server-initiated request `id`. */
function nextResponseFor(child: FakeChildProcess, id: unknown, timeoutMs = 1000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      for (const line of child.writtenLines) {
        if (line && typeof line === 'object') {
          const obj = line as Record<string, unknown>;
          if (obj.id === id && ('result' in obj || 'error' in obj)) {
            resolve(obj);
            return;
          }
        }
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`timeout waiting for response to ${JSON.stringify(id)}; saw: ${JSON.stringify(child.writtenLines)}`));
        return;
      }
      setTimeout(check, 5);
    };
    check();
  });
}

describe('CodexAppServerProtocol', () => {
  let child: FakeChildProcess;

  beforeEach(() => {
    child = new FakeChildProcess();
    spawnMock.mockReset();
    spawnMock.mockReturnValue(child);
    taskkillSpawnMock.mockReset();
    taskkillSpawnMock.mockImplementation(() => {
      const taskkill = {
        once: vi.fn((event: string, callback: (...args: unknown[]) => void) => {
          if (event === 'exit') queueMicrotask(() => callback(0, null));
          return taskkill;
        }),
        unref: vi.fn(),
        kill: vi.fn(() => true),
      };
      return taskkill;
    });
  });

  afterEach(() => {
    if (!child.killed) child.kill();
  });

  it('spawns the codex binary, completes the initialize handshake, and starts a thread', async () => {
    const protocol = new CodexAppServerProtocol();
    const sessionPromise = protocol.createSession({
      workspacePath: '/tmp/ws',
    });

    // Initialize round trip
    const initReq = await nextWrittenMatching(child, 'initialize');
    expect(initReq.method).toBe('initialize');
    expect((initReq.params as { clientInfo: { name: string } }).clientInfo.name).toBe('nimbalyst');
    child.emitLine({ id: initReq.id, result: { codexHome: '/fake', platformFamily: 'unix', platformOs: 'macos', userAgent: 'fake/0' } });

    // initialized notification
    await new Promise((r) => setTimeout(r, 10));
    expect(child.writtenLines.some((l) => (l as { method?: string }).method === 'initialized')).toBe(true);

    // thread/start round trip
    const startReq = await nextWrittenMatching(child, 'thread/start');
    expect((startReq.params as { sandbox: string }).sandbox).toBe('workspace-write');
    expect((startReq.params as { approvalPolicy: string }).approvalPolicy).toBe('never');
    child.emitLine({ id: startReq.id, result: { thread: { id: 'thread-abc' } } });

    const session = await sessionPromise;
    expect(session.id).toBe('thread-abc');
    expect(session.platform).toBe('codex-app-server');

    // Spawn arguments
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [bin, args] = spawnMock.mock.calls[0];
    expect(bin).toBe('/fake/codex');
    expect(args).toEqual(['app-server', '--listen', 'stdio://']);

    protocol.cleanupSession(session);
  });

  it('uses Codex automatic review for Agent-verified workspaces', async () => {
    const protocol = new CodexAppServerProtocol();
    const sessionPromise = protocol.createSession({
      workspacePath: '/tmp/ws',
      permissionMode: 'bypass-all',
      raw: { agentVerified: true },
    });

    const initReq = await nextWrittenMatching(child, 'initialize');
    child.emitLine({
      id: initReq.id,
      result: {
        codexHome: '/fake',
        platformFamily: 'unix',
        platformOs: 'macos',
        userAgent: 'fake/0',
      },
    });

    const startReq = await nextWrittenMatching(child, 'thread/start');
    expect(startReq.params).toMatchObject({
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review',
    });
    child.emitLine({ id: startReq.id, result: { thread: { id: 'thread-agent-verified' } } });

    const session = await sessionPromise;
    protocol.cleanupSession(session);
  });

  it('keeps raw Allow everything on unrestricted access without reviews', async () => {
    const protocol = new CodexAppServerProtocol();
    const sessionPromise = protocol.createSession({
      workspacePath: '/tmp/ws',
      permissionMode: 'bypass-all',
      raw: { agentVerified: false },
    });

    const initReq = await nextWrittenMatching(child, 'initialize');
    child.emitLine({
      id: initReq.id,
      result: {
        codexHome: '/fake',
        platformFamily: 'unix',
        platformOs: 'macos',
        userAgent: 'fake/0',
      },
    });

    const startReq = await nextWrittenMatching(child, 'thread/start');
    expect(startReq.params).toMatchObject({
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
    });
    expect(startReq.params).not.toHaveProperty('approvalsReviewer');
    child.emitLine({ id: startReq.id, result: { thread: { id: 'thread-allow-everything' } } });

    const session = await sessionPromise;
    protocol.cleanupSession(session);
  });

  it('routes cleanup through the owned process-tree terminator exactly once', async () => {
    const terminateProcessTree = vi.fn((ownedChild: FakeChildProcess) => {
      // Keep the root alive until the tree terminator has captured it. Ending
      // stdin first can make codex exit before taskkill /T can traverse.
      expect(ownedChild.stdin.writableEnded).toBe(false);
    });
    const protocol = new CodexAppServerProtocol({
      terminateProcessTreeOverride: terminateProcessTree,
    } as never);
    const sessionPromise = protocol.createSession({ workspacePath: '/tmp/ws' });
    const initReq = await nextWrittenMatching(child, 'initialize');
    child.emitLine({ id: initReq.id, result: { codexHome: '/fake', platformFamily: 'unix', platformOs: 'macos', userAgent: 'fake/0' } });
    const startReq = await nextWrittenMatching(child, 'thread/start');
    child.emitLine({ id: startReq.id, result: { thread: { id: 'thread-cleanup' } } });
    const session = await sessionPromise;

    protocol.cleanupSession(session);
    protocol.cleanupSession(session);

    expect(terminateProcessTree).toHaveBeenCalledTimes(1);
    expect(terminateProcessTree).toHaveBeenCalledWith(child);
    // The tree terminator owns shutdown now. Closing stdin here would race the
    // detached taskkill process and could erase its root before traversal.
    expect(child.stdin.writableEnded).toBe(false);
  });

  it('streams agentMessage deltas as text events and emits complete on turn/completed', async () => {
    const protocol = new CodexAppServerProtocol();
    const sessionPromise = protocol.createSession({ workspacePath: '/tmp/ws' });
    const initReq = await nextWrittenMatching(child, 'initialize');
    child.emitLine({ id: initReq.id, result: { codexHome: '/fake', platformFamily: 'unix', platformOs: 'macos', userAgent: 'fake/0' } });
    const startReq = await nextWrittenMatching(child, 'thread/start');
    child.emitLine({ id: startReq.id, result: { thread: { id: 'thread-abc' } } });
    const session = await sessionPromise;

    const events: ProtocolEvent[] = [];
    const collector = (async () => {
      for await (const ev of protocol.sendMessage(session, { content: 'hi' })) {
        events.push(ev);
      }
    })();

    const turnReq = await nextWrittenMatching(child, 'turn/start');
    child.emitLine({ id: turnReq.id, result: { turn: { id: 'turn-1', items: [], status: 'inProgress' } } });

    child.emitLine({ method: 'turn/started', params: { threadId: 'thread-abc', turnId: 'turn-1' } });
    child.emitLine({ method: 'item/agentMessage/delta', params: { threadId: 'thread-abc', turnId: 'turn-1', itemId: 'msg-1', delta: 'Hello' } });
    child.emitLine({ method: 'item/agentMessage/delta', params: { threadId: 'thread-abc', turnId: 'turn-1', itemId: 'msg-1', delta: ' world' } });
    child.emitLine({ method: 'turn/completed', params: { threadId: 'thread-abc', turn: { id: 'turn-1', status: 'completed' } } });

    await collector;

    const textEvents = events.filter((e) => e.type === 'text');
    expect(textEvents.map((e) => e.content).join('')).toBe('Hello world');
    expect(events[events.length - 1]).toMatchObject({ type: 'complete', content: 'Hello world' });

    protocol.cleanupSession(session);
  });

  // #1251: the payload below is copied verbatim from a live codex 0.144.1
  // app-server (temptests/codex-appserver-probe.mjs). The notification nests
  // everything under `tokenUsage`, not `usage`, so the old reader always saw
  // undefined and every Codex turn reported zero tokens and no context fill.
  //
  // `last` is the context fill and `total` is cumulative thread spend: after a
  // compaction `total` held at 19147 while `last` dropped to 4555.
  it('reports context fill and window from thread/tokenUsage/updated', async () => {
    const protocol = new CodexAppServerProtocol();
    const sessionPromise = protocol.createSession({ workspacePath: '/tmp/ws' });
    const initReq = await nextWrittenMatching(child, 'initialize');
    child.emitLine({ id: initReq.id, result: { codexHome: '/fake', platformFamily: 'unix', platformOs: 'macos', userAgent: 'fake/0' } });
    const startReq = await nextWrittenMatching(child, 'thread/start');
    child.emitLine({ id: startReq.id, result: { thread: { id: 'thread-abc' } } });
    const session = await sessionPromise;

    const events: ProtocolEvent[] = [];
    const collector = (async () => {
      for await (const ev of protocol.sendMessage(session, { content: 'hi' })) events.push(ev);
    })();

    const turnReq = await nextWrittenMatching(child, 'turn/start');
    child.emitLine({ id: turnReq.id, result: { turn: { id: 'turn-1', items: [], status: 'inProgress' } } });
    child.emitLine({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'thread-abc',
        turnId: 'turn-1',
        tokenUsage: {
          total: { totalTokens: 19151, inputTokens: 19146, cachedInputTokens: 9984, outputTokens: 5, reasoningOutputTokens: 0 },
          last: { totalTokens: 4555, inputTokens: 4550, cachedInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 0 },
          modelContextWindow: 258400,
        },
      },
    });
    child.emitLine({ method: 'turn/completed', params: { threadId: 'thread-abc', turn: { id: 'turn-1', status: 'completed' } } });

    await collector;

    const complete = events[events.length - 1];
    expect(complete).toMatchObject({
      type: 'complete',
      contextFillTokens: 4555,
      contextWindow: 258400,
      usage: { input_tokens: 19146, output_tokens: 5, total_tokens: 19151 },
    });

    protocol.cleanupSession(session);
  });

  // #1251 follow-on: turn/completed carries no usage at all on this transport
  // (confirmed across 1,663 recorded turns), so the zeroed fallback must not be
  // the only thing a turn can report.
  it('does not report all-zero usage when tokenUsage arrived earlier in the turn', async () => {
    const protocol = new CodexAppServerProtocol();
    const sessionPromise = protocol.createSession({ workspacePath: '/tmp/ws' });
    const initReq = await nextWrittenMatching(child, 'initialize');
    child.emitLine({ id: initReq.id, result: { codexHome: '/fake', platformFamily: 'unix', platformOs: 'macos', userAgent: 'fake/0' } });
    const startReq = await nextWrittenMatching(child, 'thread/start');
    child.emitLine({ id: startReq.id, result: { thread: { id: 'thread-abc' } } });
    const session = await sessionPromise;

    const events: ProtocolEvent[] = [];
    const collector = (async () => {
      for await (const ev of protocol.sendMessage(session, { content: 'hi' })) events.push(ev);
    })();

    const turnReq = await nextWrittenMatching(child, 'turn/start');
    child.emitLine({ id: turnReq.id, result: { turn: { id: 'turn-1', items: [], status: 'inProgress' } } });
    child.emitLine({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'thread-abc',
        turnId: 'turn-1',
        tokenUsage: {
          total: { totalTokens: 100, inputTokens: 90, outputTokens: 10 },
          last: { totalTokens: 100, inputTokens: 90, outputTokens: 10 },
          modelContextWindow: 400000,
        },
      },
    });
    // Verbatim from the probe: no `usage` key anywhere on this notification.
    child.emitLine({
      method: 'turn/completed',
      params: { threadId: 'thread-abc', turn: { id: 'turn-1', status: 'completed', startedAt: 1, completedAt: 2, durationMs: 1 } },
    });

    await collector;

    const complete = events[events.length - 1];
    expect(complete.type).toBe('complete');
    expect(complete.usage?.total_tokens).toBe(100);
  });

  // #1252: the Compact button used to send the literal string "/compact" as a
  // user turn, which reached the model as prompt text and did nothing. The
  // app-server has a real RPC for this; against a live server it dropped the
  // context fill from 19147 to 4555.
  it('compacts via thread/compact/start rather than a literal /compact message', async () => {
    const protocol = new CodexAppServerProtocol();
    const sessionPromise = protocol.createSession({ workspacePath: '/tmp/ws' });
    const initReq = await nextWrittenMatching(child, 'initialize');
    child.emitLine({ id: initReq.id, result: { codexHome: '/fake', platformFamily: 'unix', platformOs: 'macos', userAgent: 'fake/0' } });
    const startReq = await nextWrittenMatching(child, 'thread/start');
    child.emitLine({ id: startReq.id, result: { thread: { id: 'thread-abc' } } });
    const session = await sessionPromise;

    const compactPromise = protocol.compactSession(session);
    const compactReq = await nextWrittenMatching(child, 'thread/compact/start');
    expect(compactReq.params).toEqual({ threadId: 'thread-abc' });
    child.emitLine({ id: compactReq.id, result: {} });

    await expect(compactPromise).resolves.toBeUndefined();
    expect(child.writtenLines.some((l) => (l as { method?: string }).method === 'turn/start')).toBe(false);

    protocol.cleanupSession(session);
  });

  it('surfaces a failed compaction instead of resolving silently', async () => {
    const protocol = new CodexAppServerProtocol();
    const sessionPromise = protocol.createSession({ workspacePath: '/tmp/ws' });
    const initReq = await nextWrittenMatching(child, 'initialize');
    child.emitLine({ id: initReq.id, result: { codexHome: '/fake', platformFamily: 'unix', platformOs: 'macos', userAgent: 'fake/0' } });
    const startReq = await nextWrittenMatching(child, 'thread/start');
    child.emitLine({ id: startReq.id, result: { thread: { id: 'thread-abc' } } });
    const session = await sessionPromise;

    const compactPromise = protocol.compactSession(session);
    const compactReq = await nextWrittenMatching(child, 'thread/compact/start');
    child.emitLine({ id: compactReq.id, error: { code: -32600, message: 'nothing to compact' } });

    await expect(compactPromise).rejects.toThrow(/compact/i);

    protocol.cleanupSession(session);
  });

  // #1253: AgentWorkflowService already exports Nimbalyst's skills to
  // <workspace>/.agents/skills/.nimbalyst-generated for Codex, but codex never
  // scanned that directory, so the agent saw none of them. Against a live
  // app-server, registering this root took the visible skill count from 16 to
  // 105.
  it('registers the workspace skills root so Nimbalyst skills reach the agent', async () => {
    const protocol = new CodexAppServerProtocol();
    const sessionPromise = protocol.createSession({ workspacePath: '/tmp/ws' });
    const initReq = await nextWrittenMatching(child, 'initialize');
    child.emitLine({ id: initReq.id, result: { codexHome: '/fake', platformFamily: 'unix', platformOs: 'macos', userAgent: 'fake/0' } });

    const rootsReq = await nextWrittenMatching(child, 'skills/extraRoots/set');
    expect(rootsReq.params).toEqual({
      extraRoots: ['/tmp/ws/.agents/skills/.nimbalyst-generated'],
    });
    child.emitLine({ id: rootsReq.id, result: {} });

    const startReq = await nextWrittenMatching(child, 'thread/start');
    child.emitLine({ id: startReq.id, result: { thread: { id: 'thread-abc' } } });
    const session = await sessionPromise;
    expect(session.id).toBe('thread-abc');

    protocol.cleanupSession(session);
  });

  // An older codex without the skills/ namespace must not take every session
  // down -- skills are an enhancement, not a precondition for running a turn.
  it('starts the thread anyway when the codex build has no skills/extraRoots/set', async () => {
    const protocol = new CodexAppServerProtocol();
    const sessionPromise = protocol.createSession({ workspacePath: '/tmp/ws' });
    const initReq = await nextWrittenMatching(child, 'initialize');
    child.emitLine({ id: initReq.id, result: { codexHome: '/fake', platformFamily: 'unix', platformOs: 'macos', userAgent: 'fake/0' } });

    const rootsReq = await nextWrittenMatching(child, 'skills/extraRoots/set');
    child.emitLine({ id: rootsReq.id, error: { code: -32601, message: 'Method not found' } });

    const startReq = await nextWrittenMatching(child, 'thread/start');
    child.emitLine({ id: startReq.id, result: { thread: { id: 'thread-abc' } } });

    const session = await sessionPromise;
    expect(session.id).toBe('thread-abc');

    protocol.cleanupSession(session);
  });

  it('ignores child-thread and stale-turn completion until the active root turn completes', async () => {
    const protocol = new CodexAppServerProtocol();
    const sessionPromise = protocol.createSession({ workspacePath: '/tmp/ws' });
    const initReq = await nextWrittenMatching(child, 'initialize');
    child.emitLine({ id: initReq.id, result: { codexHome: '/fake', platformFamily: 'unix', platformOs: 'macos', userAgent: 'fake/0' } });
    const startReq = await nextWrittenMatching(child, 'thread/start');
    child.emitLine({ id: startReq.id, result: { thread: { id: 'thread-root' } } });
    const session = await sessionPromise;

    const events: ProtocolEvent[] = [];
    let streamCompleted = false;
    const collector = (async () => {
      for await (const ev of protocol.sendMessage(session, { content: 'delegate and synthesize' })) {
        events.push(ev);
      }
      streamCompleted = true;
    })();

    const turnReq = await nextWrittenMatching(child, 'turn/start');
    child.emitLine({ id: turnReq.id, result: { turn: { id: 'turn-root', items: [], status: 'inProgress' } } });

    child.emitLine({ method: 'item/agentMessage/delta', params: { threadId: 'thread-child', turnId: 'turn-child', itemId: 'msg-child', delta: 'child-only report' } });
    child.emitLine({ method: 'item/completed', params: { threadId: 'thread-child', turnId: 'turn-child', item: { type: 'agentMessage', id: 'msg-child', text: 'child-only report' } } });
    child.emitLine({ method: 'turn/completed', params: { threadId: 'thread-child', turn: { id: 'turn-child', status: 'completed' } } });
    child.emitLine({ method: 'turn/completed', params: { threadId: 'thread-root', turn: { id: 'turn-stale', status: 'completed' } } });
    await Promise.resolve();

    expect(streamCompleted).toBe(false);
    expect(events).toHaveLength(0);

    child.emitLine({ method: 'item/agentMessage/delta', params: { threadId: 'thread-root', turnId: 'turn-root', itemId: 'msg-root', delta: 'root synthesis' } });
    child.emitLine({ method: 'turn/completed', params: { threadId: 'thread-root', turn: { id: 'turn-root', status: 'completed' } } });

    await collector;

    expect(events.filter((event) => event.type === 'text').map((event) => event.content)).toEqual(['root synthesis']);
    expect(events.filter((event) => event.type === 'complete')).toHaveLength(1);
    expect(events[events.length - 1]).toMatchObject({ type: 'complete', content: 'root synthesis' });

    protocol.cleanupSession(session);
  });

  it('translates fileChange item/completed into a tool_call event with diff-based baselines', async () => {
    const protocol = new CodexAppServerProtocol();
    const sessionPromise = protocol.createSession({ workspacePath: '/tmp/ws' });
    const initReq = await nextWrittenMatching(child, 'initialize');
    child.emitLine({ id: initReq.id, result: { codexHome: '/fake', platformFamily: 'unix', platformOs: 'macos', userAgent: 'fake/0' } });
    const startReq = await nextWrittenMatching(child, 'thread/start');
    child.emitLine({ id: startReq.id, result: { thread: { id: 't-1' } } });
    const session = await sessionPromise;

    const events: ProtocolEvent[] = [];
    const collector = (async () => {
      for await (const ev of protocol.sendMessage(session, { content: 'edit please' })) {
        events.push(ev);
      }
    })();

    const turnReq = await nextWrittenMatching(child, 'turn/start');
    child.emitLine({ id: turnReq.id, result: { turn: { id: 'turn-1', items: [], status: 'inProgress' } } });

    child.emitLine({
      method: 'item/completed',
      params: {
        threadId: 't-1',
        turnId: 'turn-1',
        item: {
          id: 'call_abc',
          type: 'fileChange',
          status: 'completed',
          changes: [
            { path: '/tmp/ws/new.md', kind: { type: 'add' }, diff: 'fresh content\n' },
            { path: '/tmp/ws/old.md', kind: { type: 'update', move_path: null }, diff: '@@ -1,1 +1,1 @@\n-old\n+new\n' },
          ],
        },
      },
    });
    child.emitLine({ method: 'turn/completed', params: { threadId: 't-1', turn: { id: 'turn-1', status: 'completed' } } });

    await collector;

    const toolCalls = events.filter((e) => e.type === 'tool_call');
    expect(toolCalls.length).toBe(1);
    const meta = toolCalls[0].metadata as { fileChangeBaselines: Array<{ path: string; kind: string; preEditContent: string | null | 'requires-post-edit-content' }> };
    expect(meta.fileChangeBaselines).toHaveLength(2);
    expect(meta.fileChangeBaselines[0]).toMatchObject({ kind: 'add', preEditContent: null });
    expect(meta.fileChangeBaselines[1]).toMatchObject({ kind: 'update', preEditContent: 'requires-post-edit-content' });

    protocol.cleanupSession(session);
  });

  it('surfaces turn/failed as an error event', async () => {
    const protocol = new CodexAppServerProtocol();
    const sessionPromise = protocol.createSession({ workspacePath: '/tmp/ws' });
    const initReq = await nextWrittenMatching(child, 'initialize');
    child.emitLine({ id: initReq.id, result: { codexHome: '/fake', platformFamily: 'unix', platformOs: 'macos', userAgent: 'fake/0' } });
    const startReq = await nextWrittenMatching(child, 'thread/start');
    child.emitLine({ id: startReq.id, result: { thread: { id: 't-1' } } });
    const session = await sessionPromise;

    const events: ProtocolEvent[] = [];
    const collector = (async () => {
      for await (const ev of protocol.sendMessage(session, { content: 'fail please' })) {
        events.push(ev);
      }
    })();

    const turnReq = await nextWrittenMatching(child, 'turn/start');
    child.emitLine({ id: turnReq.id, result: { turn: { id: 'turn-1', items: [], status: 'inProgress' } } });
    child.emitLine({
      method: 'turn/completed',
      params: { threadId: 't-1', turn: { id: 'turn-1', status: 'failed', error: { message: 'model unavailable' } } },
    });

    await collector;

    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent?.error).toContain('model unavailable');

    protocol.cleanupSession(session);
  });

  it('passes MCP server config through ThreadStartParams.config', async () => {
    const protocol = new CodexAppServerProtocol();
    const sessionPromise = protocol.createSession({
      workspacePath: '/tmp/ws',
      raw: {
        codexConfigOverrides: {
          mcp_servers: {
            'nimbalyst-mcp': { command: 'node', args: ['/path/to/mcp.js'], env: { TOKEN: 'x' } },
          },
        },
      },
    } as never);
    const initReq = await nextWrittenMatching(child, 'initialize');
    child.emitLine({ id: initReq.id, result: { codexHome: '/fake', platformFamily: 'unix', platformOs: 'macos', userAgent: 'fake/0' } });
    const startReq = await nextWrittenMatching(child, 'thread/start');
    const params = startReq.params as { config: { mcp_servers: Record<string, unknown> } };
    expect(params.config).toBeDefined();
    expect(params.config.mcp_servers).toEqual({
      'nimbalyst-mcp': { command: 'node', args: ['/path/to/mcp.js'], env: { TOKEN: 'x' } },
    });
    child.emitLine({ id: startReq.id, result: { thread: { id: 't-mcp' } } });
    const session = await sessionPromise;
    protocol.cleanupSession(session);
  });

  it('answers mcpServer/elicitation/request with an accept struct, not null (#797)', async () => {
    // Regression: codex forwards MCP tool-approval as an elicitation request.
    // Replying `null` fails codex's deserializer and it reports every nimbalyst
    // MCP tool call as "user rejected MCP tool call" with no visible prompt.
    const protocol = new CodexAppServerProtocol();
    const sessionPromise = protocol.createSession({ workspacePath: '/tmp/ws' });
    const initReq = await nextWrittenMatching(child, 'initialize');
    child.emitLine({ id: initReq.id, result: { codexHome: '/fake', platformFamily: 'unix', platformOs: 'macos', userAgent: 'fake/0' } });
    const startReq = await nextWrittenMatching(child, 'thread/start');
    child.emitLine({ id: startReq.id, result: { thread: { id: 'thread-elicit' } } });
    const session = await sessionPromise;

    // Codex asks the client to handle an MCP elicitation (tool approval).
    child.emitLine({
      id: 'elicit-1',
      method: 'mcpServer/elicitation/request',
      params: { serverName: 'nimbalyst-trackers', message: 'approve tracker_list?' },
    });

    const response = await nextResponseFor(child, 'elicit-1');
    expect(response.error).toBeUndefined();
    expect(response.result).not.toBeNull();
    expect(response.result).toMatchObject({ action: 'accept' });

    protocol.cleanupSession(session);
  });

  it('resumes an existing thread via thread/resume', async () => {
    const protocol = new CodexAppServerProtocol();
    const sessionPromise = protocol.resumeSession('existing-thread-id', { workspacePath: '/tmp/ws' });
    const initReq = await nextWrittenMatching(child, 'initialize');
    child.emitLine({ id: initReq.id, result: { codexHome: '/fake', platformFamily: 'unix', platformOs: 'macos', userAgent: 'fake/0' } });
    const resumeReq = await nextWrittenMatching(child, 'thread/resume');
    expect((resumeReq.params as { threadId: string }).threadId).toBe('existing-thread-id');
    child.emitLine({ id: resumeReq.id, result: { thread: { id: 'existing-thread-id' } } });
    const session = await sessionPromise;
    expect(session.id).toBe('existing-thread-id');
    protocol.cleanupSession(session);
  });

  // #1254: a failed resume used to be swallowed and downgraded to thread/start.
  // The transcript still showed the prior messages, so the agent looked like it
  // had forgotten everything rather than like something had gone wrong.
  it('fails the turn when thread/resume errors instead of silently starting a new thread', async () => {
    const protocol = new CodexAppServerProtocol();
    const sessionPromise = protocol.resumeSession('missing-thread-id', { workspacePath: '/tmp/ws' });
    const initReq = await nextWrittenMatching(child, 'initialize');
    child.emitLine({ id: initReq.id, result: { codexHome: '/fake', platformFamily: 'unix', platformOs: 'macos', userAgent: 'fake/0' } });

    const resumeReq = await nextWrittenMatching(child, 'thread/resume');
    child.emitLine({ id: resumeReq.id, error: { code: -32600, message: 'thread not found' } });

    await expect(sessionPromise).rejects.toThrow(/resume/i);

    // The silent fallback would have issued a thread/start on the same child.
    expect(child.writtenLines.some((l) => (l as { method?: string }).method === 'thread/start')).toBe(false);
  });

  it('forwards mcp_servers and other thread config on thread/resume so the resumed agent has tools', async () => {
    // Each resume spawns a fresh codex app-server child; without re-attaching
    // mcp_servers (and the rest of the config we pass on first start), the
    // resumed agent has zero MCP tools available -- meaning every internal
    // Nimbalyst tool (developer_git_commit_proposal, AskUserQuestion, etc.)
    // silently disappears after the first user message in a session resumed
    // across a Nimbalyst restart.
    const protocol = new CodexAppServerProtocol();
    const sessionPromise = protocol.resumeSession('thread-resume-tools', {
      workspacePath: '/tmp/ws',
      model: 'gpt-5.4',
      systemPrompt: 'be helpful',
      permissionMode: 'auto',
      raw: {
        codexConfigOverrides: {
          mcp_servers: {
            'nimbalyst-mcp': { command: 'npx', args: ['mcp-remote', 'http://127.0.0.1:3456/mcp?sessionId=s1'] },
          },
          show_raw_agent_reasoning: true,
        },
        effortLevel: 'high',
      },
    } as never);
    const initReq = await nextWrittenMatching(child, 'initialize');
    child.emitLine({ id: initReq.id, result: { codexHome: '/fake', platformFamily: 'unix', platformOs: 'macos', userAgent: 'fake/0' } });
    const resumeReq = await nextWrittenMatching(child, 'thread/resume');
    const params = resumeReq.params as {
      threadId: string;
      cwd: string;
      sandbox?: string;
      approvalPolicy?: string;
      developerInstructions?: string;
      model?: string;
      config?: { mcp_servers?: Record<string, unknown>; show_raw_agent_reasoning?: boolean; model_reasoning_effort?: string };
    };
    expect(params.threadId).toBe('thread-resume-tools');
    expect(params.cwd).toBe('/tmp/ws');
    expect(params.sandbox).toBe('workspace-write');
    expect(params.approvalPolicy).toBe('never');
    expect(params.developerInstructions).toBe('be helpful');
    expect(params.model).toBe('gpt-5.4');
    expect(params.config).toBeDefined();
    expect(params.config!.mcp_servers).toEqual({
      'nimbalyst-mcp': { command: 'npx', args: ['mcp-remote', 'http://127.0.0.1:3456/mcp?sessionId=s1'] },
    });
    expect(params.config!.show_raw_agent_reasoning).toBe(true);
    expect(params.config!.model_reasoning_effort).toBe('high');
    // ThreadResumeParams does NOT accept `ephemeral`; codex would reject the
    // params if we forwarded it. Verify we strip it.
    expect((params as Record<string, unknown>).ephemeral).toBeUndefined();
    child.emitLine({ id: resumeReq.id, result: { thread: { id: 'thread-resume-tools' } } });
    const session = await sessionPromise;
    protocol.cleanupSession(session);
  });

  it('emits a result-less tool_call on item/started for mcpToolCall so blocking widgets can render', async () => {
    // Custom widgets (developer_git_commit_proposal, AskUserQuestion) render
    // off the tool_call event with no result. If the protocol waits until
    // item/completed -- which only fires AFTER the MCP tool returns -- the
    // widget never appears and the user can't respond, deadlocking the turn.
    const protocol = new CodexAppServerProtocol();
    const sessionPromise = protocol.createSession({ workspacePath: '/tmp/ws' });
    const initReq = await nextWrittenMatching(child, 'initialize');
    child.emitLine({ id: initReq.id, result: { codexHome: '/fake', platformFamily: 'unix', platformOs: 'macos', userAgent: 'fake/0' } });
    const startReq = await nextWrittenMatching(child, 'thread/start');
    child.emitLine({ id: startReq.id, result: { thread: { id: 't-blocking' } } });
    const session = await sessionPromise;

    const events: ProtocolEvent[] = [];
    const collector = (async () => {
      for await (const ev of protocol.sendMessage(session, { content: 'commit' })) {
        events.push(ev);
      }
    })();

    const turnReq = await nextWrittenMatching(child, 'turn/start');
    child.emitLine({ id: turnReq.id, result: { turn: { id: 'turn-1', items: [], status: 'inProgress' } } });

    // Codex emits item/started for the MCP tool *before* the tool returns.
    child.emitLine({
      method: 'item/started',
      params: {
        threadId: 't-blocking',
        turnId: 'turn-1',
        item: {
          id: 'mcp_blocking_1',
          type: 'mcpToolCall',
          status: 'pending',
          server: 'nimbalyst-mcp',
          tool: 'developer_git_commit_proposal',
          arguments: { commitMessage: 'feat: x', filesToStage: ['a.ts'] },
        },
      },
    });

    // Verify the started-stage tool_call landed before any completed event.
    await new Promise((r) => setTimeout(r, 20));
    const toolCallsAtStart = events.filter((e) => e.type === 'tool_call');
    expect(toolCallsAtStart).toHaveLength(1);
    expect(toolCallsAtStart[0].toolCall?.name).toBe('mcp__nimbalyst-mcp__developer_git_commit_proposal');
    expect(toolCallsAtStart[0].toolCall?.result).toBeUndefined();
    expect((toolCallsAtStart[0].metadata as { stage?: string })?.stage).toBe('started');

    // Then item/completed arrives (after the user clicks through the widget,
    // the MCP tool returns, and codex emits the completion).
    child.emitLine({
      method: 'item/completed',
      params: {
        threadId: 't-blocking',
        turnId: 'turn-1',
        item: {
          id: 'mcp_blocking_1',
          type: 'mcpToolCall',
          status: 'completed',
          server: 'nimbalyst-mcp',
          tool: 'developer_git_commit_proposal',
          arguments: { commitMessage: 'feat: x', filesToStage: ['a.ts'] },
          result: { success: true },
        },
      },
    });
    child.emitLine({ method: 'turn/completed', params: { threadId: 't-blocking', turn: { id: 'turn-1', status: 'completed' } } });
    await collector;

    const allToolCalls = events.filter((e) => e.type === 'tool_call');
    expect(allToolCalls).toHaveLength(2);
    expect(allToolCalls[1].toolCall?.result).toBeDefined();
    protocol.cleanupSession(session);
  });

  it('emits mcpToolCall events with the canonical mcp__server__tool name format', async () => {
    const protocol = new CodexAppServerProtocol();
    const sessionPromise = protocol.createSession({ workspacePath: '/tmp/ws' });
    const initReq = await nextWrittenMatching(child, 'initialize');
    child.emitLine({ id: initReq.id, result: { codexHome: '/fake', platformFamily: 'unix', platformOs: 'macos', userAgent: 'fake/0' } });
    const startReq = await nextWrittenMatching(child, 'thread/start');
    child.emitLine({ id: startReq.id, result: { thread: { id: 't-mcp' } } });
    const session = await sessionPromise;

    const events: ProtocolEvent[] = [];
    const collector = (async () => {
      for await (const ev of protocol.sendMessage(session, { content: 'call mcp' })) {
        events.push(ev);
      }
    })();

    const turnReq = await nextWrittenMatching(child, 'turn/start');
    child.emitLine({ id: turnReq.id, result: { turn: { id: 'turn-1', items: [], status: 'inProgress' } } });
    child.emitLine({
      method: 'item/completed',
      params: {
        threadId: 't-mcp',
        turnId: 'turn-1',
        item: {
          id: 'mcp_call_1',
          type: 'mcpToolCall',
          status: 'completed',
          server: 'nimbalyst-session-naming',
          tool: 'update_session_meta',
          arguments: { name: 'test' },
          result: 'ok',
        },
      },
    });
    child.emitLine({ method: 'turn/completed', params: { threadId: 't-mcp', turn: { id: 'turn-1', status: 'completed' } } });

    await collector;

    const toolCalls = events.filter((e) => e.type === 'tool_call');
    expect(toolCalls).toHaveLength(1);
    // The provider's session-naming detector and AskUserQuestion router both
    // strip `mcp__<server>__` from the tool name. A dotted form like
    // `nimbalyst-session-naming.update_session_meta` would silently miss those
    // checks and break detection on the app-server transport.
    expect(toolCalls[0].toolCall?.name).toBe('mcp__nimbalyst-session-naming__update_session_meta');

    protocol.cleanupSession(session);
  });

  it('falls back to generic tool_call events for unknown tool-like app-server items', async () => {
    const protocol = new CodexAppServerProtocol();
    const sessionPromise = protocol.createSession({ workspacePath: '/tmp/ws' });
    const initReq = await nextWrittenMatching(child, 'initialize');
    child.emitLine({ id: initReq.id, result: { codexHome: '/fake', platformFamily: 'unix', platformOs: 'macos', userAgent: 'fake/0' } });
    const startReq = await nextWrittenMatching(child, 'thread/start');
    child.emitLine({ id: startReq.id, result: { thread: { id: 't-generic' } } });
    const session = await sessionPromise;

    const events: ProtocolEvent[] = [];
    const collector = (async () => {
      for await (const ev of protocol.sendMessage(session, { content: 'search the web' })) {
        events.push(ev);
      }
    })();

    const turnReq = await nextWrittenMatching(child, 'turn/start');
    child.emitLine({ id: turnReq.id, result: { turn: { id: 'turn-1', items: [], status: 'inProgress' } } });

    child.emitLine({
      method: 'item/started',
      params: {
        threadId: 't-generic',
        turnId: 'turn-1',
        item: {
          id: 'web-1',
          type: 'webSearch',
          status: 'inProgress',
          query: 'claude code transcripts',
        },
      },
    });

    child.emitLine({
      method: 'item/completed',
      params: {
        threadId: 't-generic',
        turnId: 'turn-1',
        item: {
          id: 'web-1',
          type: 'webSearch',
          status: 'completed',
          query: 'claude code transcripts',
          result: { hits: 3 },
        },
      },
    });
    child.emitLine({ method: 'turn/completed', params: { threadId: 't-generic', turn: { id: 'turn-1', status: 'completed' } } });

    await collector;

    const toolCalls = events.filter((e) => e.type === 'tool_call');
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0].toolCall).toMatchObject({
      id: 'web-1',
      name: 'webSearch',
      arguments: { query: 'claude code transcripts' },
    });
    expect(toolCalls[0].toolCall?.result).toBeUndefined();
    expect(toolCalls[1].toolCall).toMatchObject({
      id: 'web-1',
      name: 'webSearch',
      arguments: { query: 'claude code transcripts' },
      result: {
        success: true,
        result: { hits: 3 },
      },
    });

    protocol.cleanupSession(session);
  });

  it('does not leak null placeholders and treats item/completed as success when webSearch omits status', async () => {
    const protocol = new CodexAppServerProtocol();
    const sessionPromise = protocol.createSession({ workspacePath: '/tmp/ws' });
    const initReq = await nextWrittenMatching(child, 'initialize');
    child.emitLine({ id: initReq.id, result: { codexHome: '/fake', platformFamily: 'unix', platformOs: 'macos', userAgent: 'fake/0' } });
    const startReq = await nextWrittenMatching(child, 'thread/start');
    child.emitLine({ id: startReq.id, result: { thread: { id: 't-web-production-shape' } } });
    const session = await sessionPromise;

    const events: ProtocolEvent[] = [];
    const collector = (async () => {
      for await (const ev of protocol.sendMessage(session, { content: 'search the web' })) {
        events.push(ev);
      }
    })();

    const turnReq = await nextWrittenMatching(child, 'turn/start');
    child.emitLine({ id: turnReq.id, result: { turn: { id: 'turn-1', items: [], status: 'inProgress' } } });
    child.emitLine({
      method: 'item/started',
      params: {
        threadId: 't-web-production-shape',
        turnId: 'turn-1',
        item: {
          id: 'web-production-shape-1',
          type: 'webSearch',
          status: null,
          query: '',
          action: null,
          results: null,
        },
      },
    });
    child.emitLine({
      method: 'item/completed',
      params: {
        threadId: 't-web-production-shape',
        turnId: 'turn-1',
        item: {
          id: 'web-production-shape-1',
          type: 'webSearch',
          status: null,
          query: 'writing process representations',
          action: { type: 'search', queries: ['writing process representations'] },
          results: [{ title: 'Result', url: 'https://example.com' }],
        },
      },
    });
    child.emitLine({ method: 'turn/completed', params: { threadId: 't-web-production-shape', turn: { id: 'turn-1', status: 'completed' } } });
    await collector;

    const toolCalls = events.filter((event) => event.type === 'tool_call');
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0].toolCall?.arguments).toEqual({});
    expect(toolCalls[1].toolCall?.result).toMatchObject({
      success: true,
      result: {
        results: [{ title: 'Result', url: 'https://example.com' }],
      },
    });

    protocol.cleanupSession(session);
  });

  it('does not duplicate notifications across multiple sendMessage calls on the same session', async () => {
    const protocol = new CodexAppServerProtocol();
    const sessionPromise = protocol.createSession({ workspacePath: '/tmp/ws' });
    const initReq = await nextWrittenMatching(child, 'initialize');
    child.emitLine({ id: initReq.id, result: { codexHome: '/fake', platformFamily: 'unix', platformOs: 'macos', userAgent: 'fake/0' } });
    const startReq = await nextWrittenMatching(child, 'thread/start');
    child.emitLine({ id: startReq.id, result: { thread: { id: 't-multi' } } });
    const session = await sessionPromise;

    // Turn 1.
    const events1: ProtocolEvent[] = [];
    const collector1 = (async () => {
      for await (const ev of protocol.sendMessage(session, { content: 'turn 1' })) {
        events1.push(ev);
      }
    })();
    const turnReq1 = await nextWrittenMatching(child, 'turn/start');
    child.emitLine({ id: turnReq1.id, result: { turn: { id: 'turn-1', items: [], status: 'inProgress' } } });
    child.emitLine({ method: 'item/agentMessage/delta', params: { threadId: 't-multi', turnId: 'turn-1', itemId: 'msg-1', delta: 'one' } });
    child.emitLine({ method: 'turn/completed', params: { threadId: 't-multi', turn: { id: 'turn-1', status: 'completed' } } });
    await collector1;
    // Drain so `nextWrittenMatching` picks up turn 2's request rather than
    // re-finding turn 1's (the helper has no cursor and matches the first
    // entry in `writtenLines`).
    child.writtenLines.length = 0;

    // Turn 2 on the same ProtocolSession. If Turn 1's notification handler is
    // still attached, every notification will fan out twice (once into Turn 1's
    // dead queue, once into Turn 2's live queue). The dead one is silently
    // dropped but in the protocol's prior implementation the side-effects --
    // duplicate raw_event entries, duplicate tool_call from a single
    // item/completed -- showed up on Turn 2's stream.
    const events2: ProtocolEvent[] = [];
    const collector2 = (async () => {
      for await (const ev of protocol.sendMessage(session, { content: 'turn 2' })) {
        events2.push(ev);
      }
    })();
    const turnReq2 = await nextWrittenMatching(child, 'turn/start');
    child.emitLine({ id: turnReq2.id, result: { turn: { id: 'turn-2', items: [], status: 'inProgress' } } });
    child.emitLine({ method: 'item/agentMessage/delta', params: { threadId: 't-multi', turnId: 'turn-2', itemId: 'msg-2', delta: 'two' } });
    child.emitLine({ method: 'turn/completed', params: { threadId: 't-multi', turn: { id: 'turn-2', status: 'completed' } } });
    await collector2;

    // Exactly one raw_event per notification on turn 2 (turn/started would be
    // missing here -- we only sent agentMessage/delta + turn/completed).
    const rawEvents2 = events2.filter((e) => e.type === 'raw_event');
    expect(rawEvents2).toHaveLength(2);
    const textEvents2 = events2.filter((e) => e.type === 'text');
    expect(textEvents2).toHaveLength(1);
    expect(textEvents2[0].content).toBe('two');
    // Only one terminating complete on turn 2.
    expect(events2.filter((e) => e.type === 'complete')).toHaveLength(1);

    // Spawn count must still be 1: no extra child for the second turn.
    expect(spawnMock).toHaveBeenCalledTimes(1);

    protocol.cleanupSession(session);
  });

  it('sends turn/interrupt and ends the stream when aborted while parked between notifications (NIM-1607)', async () => {
    // Regression: a cancel (e.g. Stop from mobile) that lands while the event
    // pump is awaiting the next codex notification was never observed -- the
    // aborted check only ran after an event arrived. With a silent child
    // (machine slept, codex hung), turn/interrupt was never sent, the
    // generator never unwound, and the session stayed 'running' forever.
    const protocol = new CodexAppServerProtocol();
    const sessionPromise = protocol.createSession({ workspacePath: '/tmp/ws' });
    const initReq = await nextWrittenMatching(child, 'initialize');
    child.emitLine({ id: initReq.id, result: { codexHome: '/fake', platformFamily: 'unix', platformOs: 'macos', userAgent: 'fake/0' } });
    const startReq = await nextWrittenMatching(child, 'thread/start');
    child.emitLine({ id: startReq.id, result: { thread: { id: 't-abort' } } });
    const session = await sessionPromise;

    // The controller for THIS turn, passed per-message. Session-level
    // raw.abortSignal is stale on cached sessions (it belongs to the turn
    // that created the session), so the per-turn signal must win.
    const controller = new AbortController();
    const events: ProtocolEvent[] = [];
    const collector = (async () => {
      for await (const ev of protocol.sendMessage(session, { content: 'long task', abortSignal: controller.signal })) {
        events.push(ev);
      }
    })();

    const turnReq = await nextWrittenMatching(child, 'turn/start');
    child.emitLine({ id: turnReq.id, result: { turn: { id: 'turn-1', items: [], status: 'inProgress' } } });
    // Reasoning starts, then codex goes silent -- no further notifications.
    child.emitLine({ method: 'item/started', params: { threadId: 't-abort', turnId: 'turn-1', item: { id: 'rs-1', type: 'reasoning' } } });
    await new Promise((r) => setTimeout(r, 20));

    controller.abort();

    // The interrupt must go out even though no further notification arrives,
    // and it MUST carry the active turnId. The app server rejects the request
    // with `-32600 missing field 'turnId'` otherwise, which silently leaves the
    // turn running and the session stuck 'running' forever (the exact symptom
    // that recurred: repeated cancels never take).
    const interruptReq = await nextWrittenMatching(child, 'turn/interrupt', 500);
    expect((interruptReq.params as { threadId: string }).threadId).toBe('t-abort');
    expect((interruptReq.params as { turnId: string }).turnId).toBe('turn-1');

    // The generator must unwind promptly so the stream consumer can finalize
    // and mark the session idle.
    const settled = await Promise.race([
      collector.then(() => 'settled'),
      new Promise<string>((r) => setTimeout(() => r('hung'), 500)),
    ]);
    expect(settled).toBe('settled');

    // Silent unwind: no complete (the turn didn't finish) and no error.
    expect(events.some((e) => e.type === 'complete')).toBe(false);
    expect(events.some((e) => e.type === 'error')).toBe(false);

    protocol.cleanupSession(session);
  });

  it('routes file-change approval RPCs through the host binding', async () => {
    const approveFileChange = vi.fn().mockResolvedValue({ decision: 'denied' });
    const protocol = new CodexAppServerProtocol({ host: { approveFileChange } });
    const sessionPromise = protocol.createSession({ workspacePath: '/tmp/ws' });
    const initReq = await nextWrittenMatching(child, 'initialize');
    child.emitLine({ id: initReq.id, result: { codexHome: '/fake', platformFamily: 'unix', platformOs: 'macos', userAgent: 'fake/0' } });
    const startReq = await nextWrittenMatching(child, 'thread/start');
    child.emitLine({ id: startReq.id, result: { thread: { id: 't-1' } } });
    await sessionPromise;

    // Server-to-client request: file change approval.
    child.emitLine({
      id: 999,
      method: 'item/fileChange/requestApproval',
      params: { threadId: 't-1', turnId: 'turn-1', itemId: 'call_abc', changes: [] },
    });

    // Wait for the response written back by the protocol.
    await new Promise((r) => setTimeout(r, 20));
    const response = child.writtenLines.find((l) => (l as { id?: unknown }).id === 999);
    expect(response).toBeDefined();
    expect((response as { result?: { decision?: string } }).result?.decision).toBe('denied');
    expect(approveFileChange).toHaveBeenCalledTimes(1);
  });

  // Codex occasionally announces an MCP tool call via item/started and never
  // sends a terminal item/completed. The call never reaches our MCP server and
  // nothing settles it, so the transcript keeps it in flight forever and the
  // agent goes on believing it is merely slow. Measured at 13/3856 (0.34%) of
  // update_session_meta calls, clustered per session.
  describe('orphaned MCP tool calls', () => {
    type PushEntry =
      | { kind: 'event'; event: ProtocolEvent }
      | { kind: 'end' }
      | { kind: 'fail'; error: Error };

    /** Drive dispatchNotification directly -- the JSON-RPC harness adds nothing here. */
    function drive(notifications: Array<[string, unknown]>): PushEntry[] {
      const protocol = new CodexAppServerProtocol();
      const pushed: PushEntry[] = [];
      for (const [method, params] of notifications) {
        (protocol as unknown as {
          dispatchNotification: (
            m: string, p: unknown, push: (e: PushEntry) => void,
            raw: unknown, appendText: (s: string) => void,
            setUsage: (u: unknown) => void, setContext: (c: unknown) => void,
          ) => void;
        }).dispatchNotification(method, params, (e) => pushed.push(e), {}, () => {}, () => {}, () => {});
      }
      return pushed;
    }

    const started = (id: string, tool: string) => [
      'item/started',
      { threadId: 't-1', turnId: 'turn-1', item: { id, type: 'mcpToolCall', server: 'nimbalyst', tool, arguments: { phase: 'validating' } } },
    ] as [string, unknown];

    const completed = (id: string, tool: string) => [
      'item/completed',
      { threadId: 't-1', turnId: 'turn-1', item: { id, type: 'mcpToolCall', server: 'nimbalyst', tool, status: 'completed', result: {} } },
    ] as [string, unknown];

    const turnCompleted = ['turn/completed', { threadId: 't-1', turn: { id: 'turn-1', status: 'completed' } }] as [string, unknown];

    const toolCalls = (pushed: PushEntry[]) =>
      pushed.filter((e): e is { kind: 'event'; event: ProtocolEvent } =>
        e.kind === 'event' && e.event.type === 'tool_call');

    it('settles a call that never completed, flagged for the host to repair', () => {
      const calls = toolCalls(drive([started('call_1', 'update_session_meta'), turnCompleted]));

      // One for item/started, one synthesized by the sweep.
      expect(calls).toHaveLength(2);
      const swept = calls[1].event.toolCall as { name?: string; result?: { success?: boolean }; orphaned?: boolean; arguments?: unknown };
      expect(swept.name).toBe('mcp__nimbalyst__update_session_meta');
      expect(swept.result?.success).toBe(false);
      // The host re-applies from these, so they must survive the sweep.
      expect(swept.orphaned).toBe(true);
      expect(swept.arguments).toEqual({ phase: 'validating' });
    });

    it('leaves a normally-completed call alone', () => {
      const pushed = drive([started('call_1', 'update_session_meta'), completed('call_1', 'update_session_meta'), turnCompleted]);
      const orphaned = toolCalls(pushed).filter(
        (c) => (c.event.toolCall as { orphaned?: boolean }).orphaned);
      expect(orphaned).toHaveLength(0);
    });

    it('sweeps only the unsettled call when a turn mixes both', () => {
      const calls = toolCalls(drive([
        started('call_1', 'update_session_meta'),
        started('call_2', 'tracker_get'),
        completed('call_2', 'tracker_get'),
        turnCompleted,
      ]));
      const orphaned = calls.filter((c) => (c.event.toolCall as { orphaned?: boolean }).orphaned);
      expect(orphaned).toHaveLength(1);
      expect((orphaned[0].event.toolCall as { name?: string }).name).toBe('mcp__nimbalyst__update_session_meta');
    });

    it('sweeps on a failed turn too, so a crash does not strand the call', () => {
      const pushed = drive([started('call_1', 'update_session_meta'), ['error', { error: { message: 'boom' } }]]);
      const orphaned = toolCalls(pushed).filter(
        (c) => (c.event.toolCall as { orphaned?: boolean }).orphaned);
      expect(orphaned).toHaveLength(1);
      expect(pushed.at(-1)).toMatchObject({ kind: 'fail' });
    });
  });
});
