// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { searchSettings, type SettingsSearchPage } from '../settingsSearch';
import type { SettingsSearchEntry } from '../settingsSearchIndex';

const pages: SettingsSearchPage[] = [
  { id: 'notifications', label: 'Notifications' },
  { id: 'advanced', label: 'Advanced' },
  { id: 'agent-features', label: 'Agent Features' },
];

const entries: SettingsSearchEntry[] = [
  { category: 'advanced', anchor: 'a-spell', name: 'Spellcheck', description: 'Enable the system spellchecker.' },
  {
    category: 'notifications',
    anchor: 'a-sounds',
    name: 'Enable Completion Sounds',
    description: 'Play an audio notification when an agent completes.',
    keywords: ['chime'],
  },
  { category: 'agent-features', anchor: 'a-upstream', name: 'Custom Claude API upstream', description: 'Route traffic through a local proxy.' },
  // Lives on a page the current setup hides (e.g. developer-only).
  { category: 'database', anchor: 'a-db', name: 'Database backend', description: 'Choose a proxy engine.' },
];

const labels = (query: string) =>
  searchSettings(query, pages, entries).map((r) => (r.kind === 'page' ? `page:${r.label}` : r.name));

describe('searchSettings', () => {
  it('returns nothing for an empty or blank query', () => {
    expect(labels('')).toEqual([]);
    expect(labels('   ')).toEqual([]);
  });

  it('ranks a page, then name matches, then description matches', () => {
    expect(
      labels('notif'),
    ).toEqual(['page:Notifications', 'Enable Completion Sounds']);
  });

  it('finds a setting by a word only its description uses', () => {
    expect(labels('proxy')).toEqual(['Custom Claude API upstream']);
  });

  it('finds a setting by keyword', () => {
    expect(labels('chime')).toEqual(['Enable Completion Sounds']);
  });

  it('requires every word, in any order and case', () => {
    expect(labels('API claude')).toEqual(['Custom Claude API upstream']);
    expect(labels('claude sounds')).toEqual([]);
  });

  it('hides settings whose page is not available in the current setup', () => {
    expect(labels('database')).toEqual([]);
  });

  it('names the page each setting lives on', () => {
    const [result] = searchSettings('spell', pages, entries);
    expect(result).toMatchObject({ kind: 'setting', category: 'advanced', anchor: 'a-spell', pageLabel: 'Advanced' });
  });
});
