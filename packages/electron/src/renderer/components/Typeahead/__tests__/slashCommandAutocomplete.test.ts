// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { buildSlashCommandOptions, supportsWorkspaceSlashCommands, type SlashCommandEntry } from '../slashCommandAutocomplete';

describe('buildSlashCommandOptions', () => {
  it('ranks exact and prefix matches first, with alphabetical ties within each match tier', () => {
    const commands: SlashCommandEntry[] = [
      { name: 'investigate-performance', source: 'project' },
      { name: 'investigate', source: 'user', argumentHint: '<problem>' },
      { name: 'debug-investigate', source: 'plugin' },
      { name: 'autoinvestigate', source: 'plugin' },
      { name: 'review', source: 'builtin' },
    ];

    for (const scope of ['commands', 'skills'] as const) {
      for (const query of ['inv', 'INV', 'investigate']) {
        const options = buildSlashCommandOptions(commands, query, scope);
        expect(options.map(option => option.id)).toEqual([
          'investigate',
          'investigate-performance',
          'debug-investigate',
          'autoinvestigate',
        ]);
        expect(options.every(option => option.section === undefined)).toBe(true);
      }
    }
    expect(commands[0].name).toBe('investigate-performance');
  });

  it('selects the exact built-in command before an alphabetically earlier substring match', () => {
    const commands: SlashCommandEntry[] = [
      { name: 'autocompact', source: 'builtin' },
      { name: 'compact', source: 'builtin' },
    ];

    for (const query of ['compact', 'COMPACT']) {
      expect(buildSlashCommandOptions(commands, query, 'commands').map(option => option.id)).toEqual([
        'compact',
        'autocompact',
      ]);
    }
  });

  it('preserves incoming order and sections without a query, including skill scope filtering', () => {
    const commands: SlashCommandEntry[] = [
      { name: 'review', source: 'builtin' },
      { name: 'zebra', source: 'project', kind: 'skill' },
      { name: 'alpha', source: 'project', kind: 'skill' },
    ];
    const options = buildSlashCommandOptions(commands, '', 'commands');
    expect(options.map(option => [option.id, option.section])).toEqual([
      ['review', 'Built-in Commands'],
      ['zebra', 'Project Skills'],
      ['alpha', 'Project Skills'],
    ]);
    expect(buildSlashCommandOptions(commands, '', 'skills')).toEqual(options.slice(1));
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
