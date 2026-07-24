#!/usr/bin/env node

/**
 * Mock ACP agent that streams a single assistant reply as many fine-grained
 * agent_message_chunk events -- the same shape produced by the real Codex
 * agent when responding to short prompts. Used by CodexACPEndToEnd.test.ts
 * to drive the chunk-merging path through the full pipeline.
 */

import { randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import {
  AgentSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
} from '@agentclientprotocol/sdk';

const REPLY_CHUNKS = ["I", "'m", " reading", " the", " repo", " instructions", " first", "."];

class ChunkedAgent {
  constructor(connection) {
    this.connection = connection;
    this.sessions = new Map();
  }

  async initialize() {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { loadSession: true },
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
    if (!this.sessions.has(params.sessionId)) {
      throw new Error(`Unknown session: ${params.sessionId}`);
    }

    for (const chunk of REPLY_CHUNKS) {
      await this.connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: chunk },
        },
      });
    }

    return {
      stopReason: 'end_turn',
      usage: { inputTokens: 4, outputTokens: REPLY_CHUNKS.length, totalTokens: 4 + REPLY_CHUNKS.length },
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

new AgentSideConnection((connection) => new ChunkedAgent(connection), stream);
