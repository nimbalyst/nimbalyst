// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  applyOrgSettingsPatch,
  DEFAULT_ORG_SETTINGS,
  normalizeOrgSettings,
} from '../orgSettings';

describe('normalizeOrgSettings', () => {
  it('defaults an organization that has never had settings written', () => {
    expect(normalizeOrgSettings(undefined)).toEqual(DEFAULT_ORG_SETTINGS);
    expect(normalizeOrgSettings(null)).toEqual(DEFAULT_ORG_SETTINGS);
    expect(normalizeOrgSettings({})).toEqual(DEFAULT_ORG_SETTINGS);
  });

  it('keeps the fields that are present and defaults only the missing ones', () => {
    // An org whose row was written before a field existed returns it missing;
    // defaulting the whole object would silently re-enable what it turned off.
    expect(normalizeOrgSettings({ messaging: { roomsEnabled: false } })).toEqual({
      version: 1,
      messaging: {
        roomsEnabled: false,
        dmsEnabled: true,
        roomCreation: 'members',
      },
    });
  });

  it('rejects values of the wrong type or shape in favour of defaults', () => {
    expect(normalizeOrgSettings({
      version: 99,
      messaging: {
        roomsEnabled: 'no',
        dmsEnabled: 0,
        roomCreation: 'owners',
      },
    })).toEqual(DEFAULT_ORG_SETTINGS);
    expect(normalizeOrgSettings({ messaging: [] })).toEqual(DEFAULT_ORG_SETTINGS);
    expect(normalizeOrgSettings(['nope'])).toEqual(DEFAULT_ORG_SETTINGS);
  });

  it('accepts both room-creation policies', () => {
    expect(normalizeOrgSettings({ messaging: { roomCreation: 'admins' } })
      .messaging.roomCreation).toBe('admins');
    expect(normalizeOrgSettings({ messaging: { roomCreation: 'members' } })
      .messaging.roomCreation).toBe('members');
  });
});

describe('applyOrgSettingsPatch', () => {
  it('folds one field into the settings the caller already holds', () => {
    const current = normalizeOrgSettings({
      messaging: { roomsEnabled: false, roomCreation: 'admins' },
    });

    // The server's PUT replaces wholesale, so an unmentioned field has to be
    // carried along or it would reset to its default.
    expect(applyOrgSettingsPatch(current, { messaging: { dmsEnabled: false } }))
      .toEqual({
        version: 1,
        messaging: {
          roomsEnabled: false,
          dmsEnabled: false,
          roomCreation: 'admins',
        },
      });
  });

  it('does not mutate the settings it was given', () => {
    const current = { ...DEFAULT_ORG_SETTINGS };
    applyOrgSettingsPatch(current, { messaging: { roomsEnabled: false } });
    expect(current.messaging.roomsEnabled).toBe(true);
  });
});
