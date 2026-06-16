/**
 * Public agent-provider surface for the Nimbalyst extension SDK.
 *
 * Extensions that ship an `AiAgentProviderContribution` import the
 * `AgentProtocol`, `AgentProtocolHost`, and supporting types from
 * this subpath:
 *
 *     import type {
 *       AgentProtocol,
 *       AgentProtocolHost,
 *       PermissionMode,
 *     } from '@nimbalyst/extension-sdk/agents';
 *
 * Ownership model (post Phase-4 dependency inversion):
 *
 *   - The transport types (`AgentProtocol`, `ProtocolEvent`, ...) are
 *     owned by the SDK in `./AgentProtocol`. The runtime re-exports
 *     them from its own `ProtocolInterface` module so existing
 *     runtime imports stay source-stable.
 *   - The host-surface types (`AgentProtocolHost`, `PermissionMode`,
 *     `McpToolDefinition`) live in this package because they only
 *     have meaning at the extension boundary.
 */

// Protocol transport types - SDK is now the source of truth.
export type {
  AgentProtocol,
  ProtocolEvent,
  ProtocolMessage,
  ProtocolSession,
  ProtocolAttachment,
  SessionOptions,
  ProtocolEventType,
  ToolResult,
  MCPServerConfig,
  RawProtocolSession,
} from './AgentProtocol.js';

// Transcript primitives (RawMessage, CanonicalEventDescriptor) are not
// re-exported in Phase 4. Antigravity uses the default claude-code parser
// (per its manifest's `transcriptParser` declaration via the
// AiAgentProviderContribution shape, when wired). When a future extension
// ships its own raw parser, this subpath gains those re-exports, but the
// runtime transcript barrel transitively pulls in renderer UI today, and
// stitching that through the SDK without a compile-only barrier (or a
// pre-built runtime dist) cascades into ambient-type errors. Deferred to a
// follow-up that either consolidates the runtime barrel or ships a pruned
// transcript-types subpath.

// Host-surface types owned by the SDK.
export type {
  AgentProtocolHost,
  PermissionMode,
  McpToolDefinition,
} from './AgentProtocolHost.js';
