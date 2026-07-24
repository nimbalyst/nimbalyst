/**
 * Protocol Adapters for Agent SDKs
 *
 * This module exports protocol adapters that normalize the differences
 * between various agent SDKs (Claude Agent SDK, OpenAI Codex SDK).
 */

export * from './ProtocolInterface';
export { ClaudeSDKProtocol } from './ClaudeSDKProtocol';
export { CodexSDKProtocol } from './CodexSDKProtocol';
export { CodexACPProtocol } from './CodexACPProtocol';
