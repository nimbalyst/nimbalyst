/**
 * Format a git commit proposal for speech without exposing file paths or body content.
 */
export function formatGitCommitProposalForVoice(data: any): string {
  const fullMessage: string = data?.commitMessage || '';
  const titleLine = fullMessage.split('\n')[0]?.trim() || '';
  return `Commit proposal: ${titleLine}. Say approve to commit or reject to cancel.`;
}
