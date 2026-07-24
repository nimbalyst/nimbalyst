#!/usr/bin/env node

/**
 * Mock ACP agent for CodexACPProtocol.test.ts. Implements the agent side of
 * the Agent Client Protocol over stdio so the protocol-under-test can be
 * exercised end-to-end without spinning up a real Codex CLI.
 *
 * Stays in lockstep with @agentclientprotocol/sdk: methods that the protocol
 * may call must be present here even if they're no-ops (otherwise the SDK
 * raises method-not-found errors that surface as protocol initialization
 * failures).
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import {
  AgentSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
} from '@agentclientprotocol/sdk';

class MockCodexAcpAgent {
  constructor(connection) {
    this.connection = connection;
    this.sessions = new Map();
  }

  async initialize() {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
      },
    };
  }

  async authenticate() {
    return {};
  }

  async newSession(params) {
    const sessionId = randomUUID();
    this.sessions.set(sessionId, { cwd: params.cwd });
    return { sessionId };
  }

  async loadSession(params) {
    if (!this.sessions.has(params.sessionId)) {
      throw new Error(`Unknown session: ${params.sessionId}`);
    }
    return {};
  }

  async setSessionMode() {
    return {};
  }

  async setSessionConfigOption() {
    return {};
  }

  async prompt(params) {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${params.sessionId}`);
    }

    const targetPath = path.join(session.cwd, 'acp-target.txt');

    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Starting ACP turn' },
      },
    });

    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-1',
        title: `acp_fs.write_text_file (${path.basename(targetPath)})`,
        kind: 'edit',
        status: 'pending',
        locations: [{ path: targetPath }],
        rawInput: { path: targetPath, content: 'after from acp\n' },
      },
    });

    const permission = await this.connection.requestPermission({
      sessionId: params.sessionId,
      toolCall: {
        toolCallId: 'tool-1',
        title: 'Apply changes',
        kind: 'edit',
        status: 'pending',
        locations: [{ path: targetPath }],
        rawInput: { path: targetPath, content: 'after from acp\n' },
        content: [
          {
            type: 'diff',
            path: targetPath,
            oldText: 'before from acp\n',
            newText: 'after from acp\n',
          },
        ],
      },
      options: [
        { optionId: 'approved-for-session', name: 'Approve for session', kind: 'allow_always' },
        { optionId: 'approved', name: 'Approve once', kind: 'allow_once' },
        { optionId: 'abort', name: 'Reject', kind: 'reject_once' },
      ],
    });

    if (permission.outcome.outcome !== 'selected' || permission.outcome.optionId === 'abort') {
      await this.connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tool-1',
          status: 'failed',
          rawOutput: { error: 'User denied ACP edit' },
        },
      });

      return {
        stopReason: 'cancelled',
        usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
      };
    }

    await this.connection.writeTextFile({
      sessionId: params.sessionId,
      path: targetPath,
      content: 'after from acp\n',
    });

    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-1',
        status: 'completed',
        rawOutput: { path: targetPath, bytesWritten: 15 },
        content: [
          {
            type: 'diff',
            path: targetPath,
            oldText: 'before from acp\n',
            newText: 'after from acp\n',
          },
        ],
      },
    });

    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: { sessionUpdate: 'usage_update', used: 42, size: 100 },
    });

    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'ACP edit applied' },
      },
    });

    return {
      stopReason: 'end_turn',
      usage: { inputTokens: 3, outputTokens: 7, totalTokens: 10 },
    };
  }

  async cancel() {
    return;
  }
}

const stream = ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin),
);

new AgentSideConnection((connection) => new MockCodexAcpAgent(connection), stream);
