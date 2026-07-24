/**
 * Git Log Tool
 *
 * MCP tool that provides git commit history.
 */

import { getGitLog } from '../utils/gitOperations';

/**
 * AI tool definition for git_log
 */
export const gitLogTool = {
  name: 'git_log',
  description: `Get recent git commit history for the current workspace.

Returns a list of recent commits with:
- Commit hash
- Commit message
- Author name
- Date

This is useful for understanding the project's commit message style before proposing a new commit.`,
  scope: 'global' as const,
  parameters: {
    type: 'object' as const,
    properties: {
      limit: {
        type: 'number' as const,
        description: 'Maximum number of commits to return (default: 10, max: 50)',
      },
    },
    required: [],
  },
  handler: async (
    params: { limit?: number },
    context: { workspacePath?: string }
  ): Promise<{ success: boolean; message?: string; data?: unknown; error?: string }> => {
    if (!context.workspacePath) {
      return {
        success: false,
        error: 'No workspace path available. Cannot get git log.',
      };
    }

    try {
      const limit = Math.min(params.limit || 10, 50);
      const commits = await getGitLog(context.workspacePath, limit);

      return {
        success: true,
        message: `Retrieved ${commits.length} recent commit(s)`,
        data: { commits },
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to get git log: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
