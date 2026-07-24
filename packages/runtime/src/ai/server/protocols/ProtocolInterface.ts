/**
 * Protocol Interface - Runtime re-export
 *
 * The protocol contract is now owned by `@nimbalyst/extension-sdk`. This
 * file remains as a runtime-side re-export so existing imports across
 * the runtime keep working without source churn.
 *
 * To change the protocol shape, edit
 * `packages/extension-sdk/src/agents/AgentProtocol.ts` (the canonical
 * home of these definitions). The runtime picks the changes up
 * automatically via this re-export.
 *
 * For new code, prefer importing directly from the SDK:
 *
 *     import type { AgentProtocol, ProtocolEvent } from '@nimbalyst/extension-sdk/agents';
 */

export type {
  AgentProtocol,
  ProtocolEvent,
  ProtocolMessage,
  ProtocolSession,
  SessionOptions,
  ProtocolEventType,
  ToolResult,
  MCPServerConfig,
  RawProtocolSession,
} from '@nimbalyst/extension-sdk/agents';
