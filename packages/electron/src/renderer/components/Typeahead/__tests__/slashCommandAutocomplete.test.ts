import { describe, expect, it } from 'vitest';
import { supportsWorkspaceSlashCommands } from '../slashCommandAutocomplete';

describe('supportsWorkspaceSlashCommands', () => {
  it('enables slash autocomplete for OpenCode sessions', () => {
    expect(supportsWorkspaceSlashCommands('opencode')).toBe(true);
  });

  it('keeps chat-only providers disabled', () => {
    expect(supportsWorkspaceSlashCommands('openai')).toBe(false);
  });
});
