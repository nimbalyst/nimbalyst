/**
 * Per-session proxy observation session for the Claude CLI (NIM-806, Phase 3 /
 * B3, Slice B). Ties the loopback SSE-tee proxy to the message assembler and
 * owns idempotency, so the production wiring only has to persist + signal.
 *
 * One observation session per CLI session (we spawn one `claude` per Nimbalyst
 * session, so a proxy-per-session is the simplest mapping). Start it BEFORE
 * spawning the CLI, hand `getBaseUrl()` to the spawn config as
 * `ANTHROPIC_BASE_URL`, and `stop()` it on PTY exit.
 *
 * Idempotency: the proxy can re-deliver a turn (CLI retries), so we skip any
 * assistant message whose Anthropic id (`msg_…`) we've already emitted. Empty
 * ids (shouldn't happen) are always emitted since they can't be deduped.
 */

import type * as http from "node:http";
import { startClaudeApiProxy, type ProxyRequestInfo } from "./claudeApiProxy";
import {
  ClaudeApiMessageAssembler,
  type AssembledAssistantMessage,
} from "./claudeApiMessageAssembler";

export interface ClaudeCliProxyObservationDeps {
  /** Nimbalyst session id this proxy observes (for logging / bridge routing). */
  sessionId: string;
  /** Called once per reassembled assistant turn (after id-dedup). */
  onAssistantMessage: (msg: AssembledAssistantMessage) => void;
  /** Raw request body of an observed `/v1/messages` (Slice E reads tool_result here). */
  onRequestBody?: (body: Record<string, unknown>, info: ProxyRequestInfo) => void;
  /** Proxy / upstream transport errors. */
  onError?: (err: Error) => void;
  /** Upstream rate-limit (429) / overloaded (529) — surfaced to the user. */
  onRateLimit?: (info: { statusCode: number; retryAfter?: string }) => void;
  /** Any non-2xx upstream response (>= 400) with a bounded error body — surfaced in the transcript. */
  onUpstreamError?: (info: { statusCode: number; body?: string; retryAfter?: string }) => void;
  /** Test seam — point the proxy at a fake upstream. Defaults to the real API. */
  upstreamUrl?: string;
}

export class ClaudeCliProxyObservation {
  private server: http.Server | null = null;
  private port: number | null = null;
  private readonly assembler: ClaudeApiMessageAssembler;
  private readonly emittedMessageIds = new Set<string>();

  constructor(private readonly deps: ClaudeCliProxyObservationDeps) {
    this.assembler = new ClaudeApiMessageAssembler((msg) => this.handleAssembled(msg));
  }

  /** Start the proxy on a loopback port. Returns the base URL for ANTHROPIC_BASE_URL. */
  async start(): Promise<{ baseUrl: string }> {
    if (this.server) return { baseUrl: this.getBaseUrl()! };
    const { server, port } = await startClaudeApiProxy(
      {
        onSSEEvent: (event, info) => {
          if (!info.observe) return;
          // Pass requestId so concurrent sub-agent + parent streams assemble in
          // isolation (the CLI runs Task sub-agents through this same proxy).
          this.assembler.processSSE(event, info.requestId);
        },
        onRequestBody: (body, info) => this.deps.onRequestBody?.(body, info),
        onProxyError: (err) => this.deps.onError?.(err),
        onRateLimit: (info) => this.deps.onRateLimit?.(info),
        onUpstreamError: (info) => this.deps.onUpstreamError?.(info),
      },
      { upstreamUrl: this.deps.upstreamUrl },
    );
    this.server = server;
    this.port = port;
    return { baseUrl: this.getBaseUrl()! };
  }

  getBaseUrl(): string | null {
    return this.port == null ? null : `http://127.0.0.1:${this.port}`;
  }

  /** Tear down the proxy and drop in-flight assembler state. */
  stop(): void {
    this.assembler.reset();
    const server = this.server;
    this.server = null;
    this.port = null;
    if (server) {
      server.close();
    }
  }

  private handleAssembled(msg: AssembledAssistantMessage): void {
    if (msg.id) {
      if (this.emittedMessageIds.has(msg.id)) return;
      this.emittedMessageIds.add(msg.id);
    }
    this.deps.onAssistantMessage(msg);
  }
}
