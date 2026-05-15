/**
 * KimiClaw Protocol
 *
 * HTTP+SSE protocol for KimiClawSwarm.
 * Stubs for now — transport filled in Slice 2, SSE parser in Slice 3.
 */

import {
  AgentProtocol,
  ProtocolSession,
  SessionOptions,
  ProtocolMessage,
  ProtocolEvent,
} from './ProtocolInterface';

export interface KimiClawSwarmOptions {
  persona_mode?: boolean;
  max_agents?: number;
  max_steps?: number;
  max_parallel?: number;
  mcp_servers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
}

export class KimiClawProtocol implements AgentProtocol {
  readonly platform = 'kimiclaw';

  // Fix A: conversational continuity — last deliverable per session
  private sessionDeliverables = new Map<string, string>();

  async createSession(options: SessionOptions): Promise<ProtocolSession> {
    return { id: crypto.randomUUID(), platform: this.platform, raw: { options } };
  }

  async resumeSession(sessionId: string, options: SessionOptions): Promise<ProtocolSession> {
    return this.createSession(options);
  }

  async forkSession(sessionId: string, options: SessionOptions): Promise<ProtocolSession> {
    return this.createSession(options);
  }

  /**
   * Stub: filled in Slice 3.
   */
  async *sendMessage(
    session: ProtocolSession,
    message: ProtocolMessage,
  ): AsyncIterable<ProtocolEvent> {
    yield { type: 'text', content: '[KimiClawProtocol] sendMessage not yet implemented' };
    yield { type: 'complete', metadata: {} };
  }

  abortSession(_session: ProtocolSession): void {
    // no-op stub
  }

  cleanupSession(_session: ProtocolSession): void {
    // no-op stub
  }
}
