/**
 * AgentProtocolHost
 * -----------------
 *
 * Surface that the host (Nimbalyst) provides to an extension-owned
 * `AgentProtocol` implementation at runtime. The protocol implementation
 * lives in an extension's backend module and is brokered to the host by
 * the privileged-host backend-module runtime; it must never reach for
 * host internals directly.
 *
 * Identity fields are immutable for the lifetime of the host: they
 * identify which extension contribution this protocol instance belongs
 * to and which backend module is hosting it. Per-turn inputs (session
 * id, workspace path, model, abort signal, permission mode, MCP
 * servers, environment) are immutable for the lifetime of a single
 * turn but may differ between turns on the same host instance.
 *
 * All async methods reject when the underlying broker call is rejected
 * by the host (missing permission, unknown session, workspace
 * mismatch, etc.) -- the protocol implementation is expected to
 * surface those rejections as protocol-level errors rather than
 * swallowing them.
 *
 * -------------------------------------------------------------------
 * Q7 -- scope of this host (Phase-4 SDK proposal, resolved 2026-06-02)
 * -------------------------------------------------------------------
 *
 * Per Q7 (Phase-4 SDK proposal, resolved 2026-06-02):
 * emitEvent / requestPermission / askUserQuestion stay provider-private
 * per the established upstream pattern (OpenAICodexProvider:1422-1491,
 * claudeCode/askUserQuestion.ts:10, ProviderSessionManager.ts:49).
 * Section 4.3's full facade is the agreed end-state, hoisted
 * incrementally when each in-tree provider is next touched. Phase 4
 * therefore ships the minimal 5-method host below; the missing
 * methods are NOT a regression -- they live on the provider's own
 * surface today and migrate behind a stable facade as each provider
 * is reworked.
 *
 * See `docs/EXTENSION_ARCHITECTURE.md` and the Phase 4 SDK design doc
 * (Section 4.3) for the full host contract.
 */

import type { MCPServerConfig } from './index';

/**
 * Permission posture the host has set for the current turn.
 *
 * - `ask`   -- prompt the user for every tool call that requires
 *              consent.
 * - `auto`  -- pre-approved tool calls run without prompting;
 *              everything else still goes through the provider's own
 *              permission path (see Q7 above).
 * - `plan`  -- read-only / planning posture; the protocol
 *              implementation MUST NOT invoke side-effecting tools
 *              and SHOULD use this hint to bias the model toward
 *              planning output.
 *
 * This is advisory metadata about the host's posture. The provider's
 * own permission code (kept provider-private per Q7) is still the
 * authoritative gate at tool-call time.
 */
export type PermissionMode = 'ask' | 'auto' | 'plan';

/**
 * MCP tool the protocol implementation wants to register with the
 * host for this session. The host federates these into the
 * session-wide tool registry and exposes them to the model alongside
 * built-in tools.
 */
export interface McpToolDefinition {
  /**
   * Tool name as the model will see it (e.g.
   * `mcp__antigravity__plan`).
   */
  name: string;

  /**
   * Short description for the model and for the consent prompt.
   */
  description: string;

  /**
   * JSON Schema for the tool's input. The host validates calls
   * against this before invoking the handler.
   */
  inputSchema: Record<string, unknown>;
}

/**
 * Host surface passed to an extension's `AgentProtocol`
 * implementation.
 *
 * Identity fields are constant; per-turn inputs are constant for the
 * lifetime of a single turn. Methods may be invoked multiple times
 * per turn (subject to the host's rate-limits and permission gates).
 *
 * Surface size is intentionally minimal -- see the Q7 note in the
 * file header for why emitEvent / requestPermission /
 * askUserQuestion are not on this interface.
 */
export interface AgentProtocolHost {
  // ----- identity (constant for the host instance) -----

  /** Extension that owns the protocol implementation. */
  readonly extensionId: string;

  /**
   * Contribution id this host instance was created for (matches the
   * `id` field on an `AiAgentProviderContribution`).
   */
  readonly providerContributionId: string;

  /**
   * Backend module id hosting the protocol implementation (matches
   * the `id` on a `BackendModuleContribution`).
   */
  readonly backendModuleId: string;

  // ----- per-turn inputs (constant within a turn) -----

  /** Active AI session id this turn belongs to. */
  readonly sessionId: string;

  /** Absolute workspace path the session is scoped to. */
  readonly workspacePath: string;

  /**
   * Model id the user picked for this turn (`undefined` if the
   * provider does not require a model selection).
   */
  readonly model?: string;

  /**
   * Abort signal that fires when the user cancels the turn or the
   * host tears the session down. Protocol implementations MUST
   * honour it promptly.
   */
  readonly abortSignal: AbortSignal;

  /** Permission posture the host has set for this turn. */
  readonly permissionMode: PermissionMode;

  /**
   * MCP servers the user has configured for this session. The
   * protocol implementation may pass these through to the
   * underlying agent runtime; the host is responsible for credential
   * resolution.
   */
  readonly mcpServers: readonly MCPServerConfig[];

  /**
   * Environment overrides the host wants applied when the protocol
   * spawns its agent runtime. Keys are environment variable names;
   * values are already-resolved strings (no template substitution).
   */
  readonly env: Readonly<Record<string, string>>;

  // ----- methods (EXACTLY 5 per Q7; see file header) -----

  /**
   * Append a raw provider-native payload to `ai_agent_messages`.
   * This is the single source of truth for the transcript; the
   * host's transcript transformer derives canonical events from it.
   *
   * `direction` is `'input'` for payloads the host sent to the
   * provider and `'output'` for payloads the provider returned.
   * `metadata` is opaque to the host; surfaced verbatim in raw-log
   * tooling.
   *
   * Resolves once the row is durably written.
   */
  logRaw(
    sessionId: string,
    direction: 'input' | 'output',
    content: string,
    metadata?: Record<string, unknown>
  ): Promise<void>;

  /**
   * Resolve an API key for the given provider id from the host's
   * settings store (the same store the user manages from Settings).
   *
   * Resolves to `undefined` when no key is configured; the protocol
   * implementation MUST NOT fall back to `process.env` (see the
   * "Never Use Environment Variables as Implicit API Key Sources"
   * rule in the project CLAUDE.md).
   */
  getApiKey(providerId: string): Promise<string | undefined>;

  /**
   * Read a workspace file via the host's filesystem broker. The
   * path is resolved against `workspacePath`; reads outside the
   * workspace are rejected.
   *
   * Returns the raw bytes; the protocol implementation is
   * responsible for decoding.
   */
  readWorkspaceFile(path: string): Promise<Uint8Array>;

  /**
   * Write a workspace file via the host's filesystem broker.
   * Subject to the extension's granted workspace-files permission;
   * writes outside the workspace are rejected.
   */
  writeWorkspaceFile(path: string, content: Uint8Array): Promise<void>;

  /**
   * Register a batch of MCP tools with the host's session-scoped
   * tool registry for the lifetime of this session. The returned
   * promise resolves once the tools are visible to the model.
   *
   * Calling again replaces the prior registration for this host
   * instance; pass an empty array to clear it. Tool handlers
   * themselves are NOT part of this contract -- per Q7, the
   * provider keeps its own dispatch path. The host only needs the
   * advertised name / description / schema to expose the tool to
   * the model and (eventually) to the provider's permission path.
   */
  registerMcpTools(tools: McpToolDefinition[]): Promise<void>;
}
