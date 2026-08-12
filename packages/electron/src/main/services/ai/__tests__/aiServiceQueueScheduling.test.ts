import { describe, expect, it } from 'vitest';
import { shouldDriveNewlyQueuedPrompt } from '../queuedPromptDrivePolicy';

describe('shouldDriveNewlyQueuedPrompt', () => {
  it('schedules a queue drive for any provider with a workspace', () => {
    expect(shouldDriveNewlyQueuedPrompt({ provider: 'openai-codex', workspacePath: 'D:/workspace' })).toBe(true);
    expect(shouldDriveNewlyQueuedPrompt({ provider: 'claude-code-cli', workspacePath: 'D:/workspace' })).toBe(true);
  });

  it('does not schedule when the session cannot be routed to a workspace', () => {
    expect(shouldDriveNewlyQueuedPrompt({ provider: 'openai-codex' })).toBe(false);
    expect(shouldDriveNewlyQueuedPrompt(null)).toBe(false);
  });
});
