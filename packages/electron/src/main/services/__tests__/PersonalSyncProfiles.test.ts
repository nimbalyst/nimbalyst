import { describe, expect, it } from 'vitest';

import {
  migratePersonalSyncProfiles,
  persistActivePersonalSyncProfile,
  switchPersonalSyncProfile,
} from '../PersonalSyncProfiles';

describe('personal sync profiles', () => {
  it('migrates the flat config once into the selected personal account', () => {
    const migrated = migratePersonalSyncProfiles({
      enabled: true,
      serverUrl: 'wss://sync.example',
      personalOrgId: 'personal-a',
      personalUserId: 'member-a',
      enabledProjects: ['/one'],
      docSyncEnabledProjects: ['/one/docs'],
      preventSleepMode: 'pluggedIn',
    });

    expect(migrated.personalSyncProfiles).toEqual({
      'personal-a': {
        enabledProjects: ['/one'],
        docSyncEnabledProjects: ['/one/docs'],
        preventSleepMode: 'pluggedIn',
      },
    });
    expect(migrated.enabledProjects).toEqual(['/one']);
  });

  it('retains both account profiles and projects while switching the live projection', () => {
    const switched = switchPersonalSyncProfile({
      enabled: true,
      serverUrl: 'wss://sync.example',
      personalOrgId: 'personal-a',
      personalUserId: 'member-a',
      enabledProjects: ['/a'],
      docSyncEnabledProjects: ['/a/docs'],
      personalSyncProfiles: {
        'personal-a': { enabledProjects: ['/a'], docSyncEnabledProjects: ['/a/docs'] },
        'personal-b': { enabledProjects: ['/b'], docSyncEnabledProjects: [] },
      },
    }, {
      personalOrgId: 'personal-b',
      personalUserId: 'member-b',
    });

    expect(switched.personalOrgId).toBe('personal-b');
    expect(switched.personalUserId).toBe('member-b');
    expect(switched.enabledProjects).toEqual(['/b']);
    expect(switched.docSyncEnabledProjects).toEqual([]);
    expect(switched.personalSyncProfiles?.['personal-a'].enabledProjects).toEqual(['/a']);
  });

  it('persists edits to the active flat projection back into that account profile', () => {
    const updated = persistActivePersonalSyncProfile({
      enabled: true,
      serverUrl: 'wss://sync.example',
      personalOrgId: 'personal-a',
      enabledProjects: ['/new'],
      docSyncEnabledProjects: ['/new/docs'],
      personalSyncProfiles: {
        'personal-a': { enabledProjects: ['/old'], docSyncEnabledProjects: [] },
        'personal-b': { enabledProjects: ['/b'], docSyncEnabledProjects: [] },
      },
    });

    expect(updated.personalSyncProfiles?.['personal-a'].enabledProjects).toEqual(['/new']);
    expect(updated.personalSyncProfiles?.['personal-b'].enabledProjects).toEqual(['/b']);
  });
});
