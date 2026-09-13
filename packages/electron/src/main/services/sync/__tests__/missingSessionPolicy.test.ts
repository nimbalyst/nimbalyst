// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  decideMissingSession,
  LEGACY_SERVER_SESSION_TTL_MS,
} from '../missingSessionPolicy';

const NOW = 1_800_000_000_000;
const decide = (over: Partial<Parameters<typeof decideMissingSession>[0]> = {}) =>
  decideMissingSession({
    sessionId: 's1',
    updatedAt: NOW - 1_000,
    isArchived: false,
    tombstonedSessionIds: new Set<string>(),
    indexProtocolVersion: 2,
    now: NOW,
    ...over,
  });

describe('decideMissingSession', () => {
  it('never republishes a session the server tombstoned', () => {
    // The absence branch would otherwise recreate a session the user deleted on
    // another device, on every sync, forever.
    expect(decide({ tombstonedSessionIds: new Set(['s1']) })).toMatchObject({
      publishIndex: false,
      syncMessages: false,
      reason: 'tombstoned',
    });
    // Tombstoned wins even for a session that would otherwise be published.
    expect(decide({
      tombstonedSessionIds: new Set(['s1']),
      updatedAt: NOW,
      indexProtocolVersion: 1,
    }).publishIndex).toBe(false);
  });

  it('never uploads expired history, including archives, on any protocol', () => {
    for (const indexProtocolVersion of [1, 2, undefined] as const) {
      for (const isArchived of [false, true]) {
        for (const updatedAt of [NOW - LEGACY_SERVER_SESSION_TTL_MS - 1, undefined, NaN]) {
          expect(decide({ updatedAt, isArchived, indexProtocolVersion })).toMatchObject({
            publishIndex: false, syncMessages: false,
          });
        }
      }
    }
    expect(decide({ updatedAt: NOW - LEGACY_SERVER_SESSION_TTL_MS })).toMatchObject({ publishIndex: true });
    expect(decide({ updatedAt: NOW })).toMatchObject({ publishIndex: true, syncMessages: true });
  });
});
