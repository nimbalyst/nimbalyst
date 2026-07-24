/**
 * Developer Extension
 *
 * Provides git operations and developer workflows through AI-accessible MCP tools.
 */

import { gitLogTool } from './mcp/gitLogTool';

// Note: gitCommitProposalTool is NOT exported here because the built-in MCP server
// handler in httpServer.ts provides this tool with proper "wait for user confirmation"
// behavior. The extension tool would return immediately, but the built-in waits for
// the user to confirm/cancel and returns the actual commit result to Claude.

// Export types for consumers
export type { GitCommit, SessionFileEdit, CommitProposal } from './types';

/**
 * Extension activation
 * Called when the extension is loaded
 */
export async function activate() {
  console.log('[Developer] Extension activated');
}

/**
 * Extension deactivation
 * Called when the extension is unloaded
 */
export async function deactivate() {
  console.log('[Developer] Extension deactivated');
}

/**
 * AI tools exported by this extension
 * These enable the coding agent to perform git operations through conversation.
 */
export const aiTools = [gitLogTool];
