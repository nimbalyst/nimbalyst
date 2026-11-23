// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const files = vi.hoisted(() => new Map<string, Record<string, unknown>>());
vi.mock('electron-store', () => ({
  default: class {
    private readonly data: Record<string, unknown>;
    constructor(options: { name: string; defaults?: Record<string, unknown> }) {
      if (!files.has(options.name)) files.set(options.name, structuredClone(options.defaults ?? {}));
      this.data = files.get(options.name)!;
    }
    get(key: string) { return structuredClone(this.data[key]); }
    set(key: string, value: unknown) { this.data[key] = structuredClone(value); }
  },
}));

import { asPersonalMemberId } from '@nimbalyst/runtime/auth/jwtScopes';
import { createPendingSessionDeletesStorage } from '../pendingSessionDeletesStorage';

const accountA = { serverUrl: 'wss://sync.example.test', orgId: 'org-a', personalMemberId: asPersonalMemberId('member-a') };
const accountB = { serverUrl: 'wss://sync.example.test', orgId: 'org-b', personalMemberId: asPersonalMemberId('member-b') };

describe('pending session deletes storage', () => {
  beforeEach(() => files.clear());

  it('keeps each sync account and server apart, so one account never sends or clears another account\'s deletes', () => {
    createPendingSessionDeletesStorage(accountA).save({ 'session-a': 1_000 });

    const b = createPendingSessionDeletesStorage(accountB);
    expect(b.load()).toEqual({});
    b.save({ 'session-b': 2_000 });
    b.save({});

    const devServer = createPendingSessionDeletesStorage({ ...accountA, serverUrl: 'ws://localhost:8790' });
    expect(devServer.load()).toEqual({});

    // A restart under account A still finds its delete.
    expect(createPendingSessionDeletesStorage(accountA).load()).toEqual({ 'session-a': 1_000 });
  });
});
