// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { buildSlashCommandOptions, supportsWorkspaceSlashCommands, type SlashCommandEntry } from '../slashCommandAutocomplete';

describe('buildSlashCommandOptions', () => {
  const commands: SlashCommandEntry[] = [
    { name: 'investigate-performance', source: 'project' },
    { name: 'investigate', source: 'user', argumentHint: '<problem>' },
    { name: 'debug-investigate', source: 'plugin' },
    { name: 'review', source: 'builtin' },
  ];

  const ids = (query: string) => buildSlashCommandOptions(commands, query, 'commands').map(option => option.id);

  it('ranks the exact name first, then prefix matches, then other matches', () => {
    expect(ids('investigate')).toEqual(['investigate', 'investigate-performance', 'debug-investigate']);
  });

  it('ranks prefix matches above word-boundary matches regardless of incoming order or case', () => {
    for (const query of ['inv', 'INV']) {
      expect(ids(query)).toEqual(['investigate', 'investigate-performance', 'debug-investigate']);
    }
    expect(commands[0].name).toBe('investigate-performance');
  });

  it('does not let an alphabetically earlier substring match outrank the typed name', () => {
    const entries: SlashCommandEntry[] = [
      { name: 'autocompact', source: 'builtin' },
      { name: 'compact', source: 'builtin' },
    ];
    expect(buildSlashCommandOptions(entries, 'compact', 'commands').map(option => option.id)).toEqual([
      'compact',
      'autocompact',
    ]);
  });

  it('sorts alphabetically within a tier and for an empty query', () => {
    expect(ids('')).toEqual(['debug-investigate', 'investigate', 'investigate-performance', 'review']);
    expect(ids('i')).toEqual(['investigate', 'investigate-performance', 'debug-investigate', 'review']);
  });
});

describe('supportsWorkspaceSlashCommands', () => {
  it('enables slash autocomplete for OpenCode sessions', () => {
    expect(supportsWorkspaceSlashCommands('opencode')).toBe(true);
  });

  it('enables slash autocomplete for terminal-CLI Claude sessions (NIM-819)', () => {
    expect(supportsWorkspaceSlashCommands('claude-code-cli')).toBe(true);
  });

  it('keeps chat-only providers disabled', () => {
    expect(supportsWorkspaceSlashCommands('openai')).toBe(false);
  });
});
