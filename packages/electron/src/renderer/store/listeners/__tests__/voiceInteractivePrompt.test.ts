import { describe, expect, it } from 'vitest';
import { formatGitCommitProposalForVoice } from '../voiceInteractivePrompt';

describe('formatGitCommitProposalForVoice', () => {
  it('reads only the commit title and asks for approve or reject with the full phrasing', () => {
    const spokenPrompt = formatGitCommitProposalForVoice({
      commitMessage: 'fix: clarify voice commit approval\n\nAvoid reading `const result = commit()` aloud.',
      filesToStage: ['packages/electron/src/main/services/voice/RealtimeAPIClient.ts'],
    });

    expect(spokenPrompt).toBe('Commit proposal: fix: clarify voice commit approval. Say approve to commit or reject to cancel.');
    expect(spokenPrompt).not.toContain('packages/electron');
    expect(spokenPrompt).not.toContain('const result');
    expect(spokenPrompt).not.toContain('Approve, or reject?');
  });
});
