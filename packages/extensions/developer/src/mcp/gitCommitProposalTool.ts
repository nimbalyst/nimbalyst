/**
 * Git Commit Proposal Tool
 *
 * MCP tool that allows the AI to propose files and commit message for a git commit.
 */

import type { CommitProposal } from '../types';

/**
 * AI tool definition for git_commit_proposal
 */
export const gitCommitProposalTool = {
  name: 'git_commit_proposal',
  description: `Propose files and commit message for a git commit using an interactive widget.

IMPORTANT: Only use this tool when:
- The user clicks the "Commit with AI" button (you'll receive an explicit message asking you to use this tool)
- The user explicitly asks for "smart commit" or "commit with AI"

Do NOT use this tool for generic commit requests like "commit this" or "make a commit".
For those, use standard git commands (git add, git commit) instead.

When using this tool:
1. If the prompt already contains a pre-fetched file list (from "Commit with AI" button), use those files directly
2. Otherwise, call get_session_edited_files to get ALL files edited in this session, then cross-reference with git status
3. Include ALL session-edited files that have changes - do not cherry-pick a subset

This tool will present an interactive widget to the user where they can review
and adjust your proposal before committing.

The commit message should follow these guidelines:
- Start with type prefix: feat:, fix:, refactor:, docs:, test:, chore:
- Focus on IMPACT and WHY, not implementation details
- Title describes user-visible outcome or bug fixed
- Use bullet points (dash prefix) only for multiple distinct changes
- Keep lines under 72 characters
- No emojis
- Lead with problem solved or capability added, not technique used`,
  scope: 'global' as const,
  parameters: {
    type: 'object' as const,
    properties: {
      filesToStage: {
        type: 'array' as const,
        items: {
          oneOf: [
            { type: 'string' as const },
            {
              type: 'object' as const,
              properties: {
                path: { type: 'string' as const, description: 'File path relative to workspace root' },
                status: {
                  type: 'string' as const,
                  enum: ['added', 'modified', 'deleted'],
                  description: 'Git status of the file'
                }
              },
              required: ['path', 'status']
            }
          ]
        },
        description: 'Array of file paths (strings) or file objects with path and status (added/modified/deleted)',
      },
      commitMessage: {
        type: 'string' as const,
        description: 'Proposed commit message following the guidelines above',
      },
      reasoning: {
        type: 'string' as const,
        description:
          'Explanation of why these files were selected and why this commit message is appropriate',
      },
    },
    required: ['filesToStage', 'commitMessage', 'reasoning'],
  },
  handler: async (
    params: CommitProposal,
    context: { workspacePath?: string }
  ): Promise<{ success: boolean; message?: string; data?: unknown; error?: string }> => {
    const { filesToStage, commitMessage, reasoning } = params;

    if (!context.workspacePath) {
      return {
        success: false,
        error: 'No workspace path available. Cannot propose commit.',
      };
    }

    if (!filesToStage || filesToStage.length === 0) {
      return {
        success: false,
        error: 'No files to commit. All files may be ignored by .gitignore or already committed.',
      };
    }

    // Return the proposal data
    // This will be rendered by the GitCommitConfirmationWidget
    return {
      success: true,
      message: 'Commit proposal created. Review and confirm in the widget below.',
      data: {
        type: 'git_commit_proposal',
        workspacePath: context.workspacePath,
        filesToStage,
        commitMessage,
        reasoning,
      },
    };
  },
};
