/**
 * Git Commit Proposal Types
 *
 * Type definitions for git commit proposals used by GitCommitConfirmationWidget.
 *
 * Note: The widget no longer uses atoms - it renders directly from tool call data.
 * The proposalId is simply toolCall.id, and the proposal data comes from toolCall.input.
 *
 * These types are kept for reference and potential future use in other parts of the codebase.
 */

export interface GitCommitProposalData {
  proposalId: string;
  toolUseId?: string;  // Claude's tool_use ID (same as toolCall.id)
  workspacePath: string;
  filesToStage: Array<string | { path: string; status: 'added' | 'modified' | 'deleted' }>;
  commitMessage: string;
  reasoning?: string;
  timestamp: number;
}

// Note: Atoms and helper functions removed - widget uses tool call data directly
// See packages/runtime/src/ui/AgentTranscript/components/CustomToolWidgets/GitCommitConfirmationWidget.tsx
