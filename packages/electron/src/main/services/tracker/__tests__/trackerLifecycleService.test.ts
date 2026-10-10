// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockDefineType, mockRegistryGet, mockRetireFile, mockQuery } = vi.hoisted(() => ({
  mockDefineType: vi.fn(),
  mockRegistryGet: vi.fn((_type: string): unknown => undefined),
  mockRetireFile: vi.fn(async () => undefined),
  mockQuery: vi.fn(async (): Promise<{ rows: Array<{ sync_id: number | null }> }> => ({ rows: [{ sync_id: null }] })),
}));

vi.mock('../../../utils/ipcRegistry', () => ({ safeHandle: vi.fn() }));
vi.mock('../../../mcp/tools/trackerToolHandlers', () => ({ handleTrackerDefineType: mockDefineType }));
vi.mock('../../TrackerSchemaService', () => ({
  ensureWorkspaceTrackerSchemasLoaded: vi.fn(),
  applyRemoteWorkspaceTrackerSchemaDef: vi.fn(async () => ({ applied: true, deleted: false })),
  applyWorkspaceLabelRegistryInProcess: vi.fn(),
  applyWorkspacePredicateRegistryInProcess: vi.fn(),
  encodeTrackerSchemaDefForPush: (def: unknown) => def,
}));
const { mockListUnsynced, mockMarkRejected } = vi.hoisted(() => ({
  mockListUnsynced: vi.fn(async (): Promise<Array<Record<string, unknown>>> => []),
  mockMarkRejected: vi.fn(async () => undefined),
}));
vi.mock('../trackerTypeDefStore', () => ({ listUnsyncedTrackerSchemaDefs: mockListUnsynced, markTrackerSchemaDefRejected: mockMarkRejected }));
vi.mock('../trackerSchemaProjection', () => ({ retireLocalSchemaFile: mockRetireFile }));
vi.mock('../../../database/initialize', () => ({ getDatabase: () => ({ query: mockQuery }) }));
vi.mock('@nimbalyst/runtime/plugins/TrackerPlugin/models', () => ({
  globalRegistry: { get: mockRegistryGet, clearWorkspaceSchema: vi.fn() },
  parseTrackerSchemaPatchYAML: vi.fn(),
  resolveTrackerPromotionEligibility: vi.fn(),
}));

import { defineNewTrackerType } from '../trackerLifecycleService';
import { publishTrackerSchemaOutcome } from '../trackerSchemaCreationOutcome';
import { createDesktopTrackerSchemaSyncHooks } from '../desktopTrackerSchemaSyncHooks';

const toolResult = (structured: object) => ({
  content: [{ type: 'text', text: JSON.stringify({ structured }) }],
  isError: false,
});

describe('defineNewTrackerType', () => {
  beforeEach(() => {
    mockDefineType.mockReset();
    mockRegistryGet.mockReset();
    mockRegistryGet.mockReturnValue(undefined);
    mockRetireFile.mockClear();
  });

  it('writes through the agent define-type path without overwrite; a personal type is done at once', async () => {
    mockDefineType.mockResolvedValue(toolResult({ type: 'library', changeScope: 'personal' }));
    const schema = { type: 'library', extends: 'technology' };
    await expect(defineNewTrackerType('/ws', schema)).resolves.toEqual({ type: 'library', scope: 'personal', status: 'created' });
    expect(mockDefineType).toHaveBeenCalledWith({ schema, overwrite: false }, '/ws');
  });

  it('a team type is created only when the room accepts this creation', async () => {
    mockDefineType.mockImplementation(async () => {
      setTimeout(() => publishTrackerSchemaOutcome('/ws', 'customer', { kind: 'settled', accepted: true }), 0);
      return toolResult({ type: 'customer', changeScope: 'team' });
    });
    await expect(defineNewTrackerType('/ws', { type: 'customer', sharing: 'team' }))
      .resolves.toEqual({ type: 'customer', scope: 'team', status: 'created' });
  });

  it('a lost race reports schemaExists to the caller and retires the local file, not leaving it as theirs', async () => {
    mockDefineType.mockImplementation(async () => {
      setTimeout(() => publishTrackerSchemaOutcome('/ws', 'customer', {
        kind: 'settled', accepted: false, code: 'schemaExists', message: 'exists',
      }), 0);
      return toolResult({ type: 'customer', changeScope: 'team' });
    });
    await expect(defineNewTrackerType('/ws', { type: 'customer', sharing: 'team' }))
      .rejects.toThrow('Someone else just created a type named "customer". Pick another name.');
    expect(mockRetireFile).toHaveBeenCalledWith('/ws', 'customer');
  });

  it("the room's own definition landing first is the same lost race; its file is the team's and stays", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ sync_id: 7 }] });
    mockDefineType.mockImplementation(async () => {
      setTimeout(() => publishTrackerSchemaOutcome('/ws', 'customer', { kind: 'roomDefined' }), 0);
      return toolResult({ type: 'customer', changeScope: 'team' });
    });
    await expect(defineNewTrackerType('/ws', { type: 'customer', sharing: 'team' }))
      .rejects.toThrow('Someone else just created a type named "customer".');
    expect(mockRetireFile).not.toHaveBeenCalled();
  });

  it('a refusal the engine reports to the desktop schema hooks reaches the caller', async () => {
    const hooks = createDesktopTrackerSchemaSyncHooks('/ws');
    mockDefineType.mockImplementation(async () => {
      setTimeout(() => hooks.onSettled?.({
        type: 'customer', model: '{}', accepted: false, error: { code: 'schemaExists', message: 'exists' },
      }), 0);
      return toolResult({ type: 'customer', changeScope: 'team' });
    });
    await expect(defineNewTrackerType('/ws', { type: 'customer', sharing: 'team' }))
      .rejects.toThrow('Someone else just created a type named "customer".');

    // And the room's definition arriving first, through the same hooks.
    mockDefineType.mockImplementation(async () => {
      setTimeout(() => { void hooks.applyRemote({ type: 'customer', model: '{}', syncId: 9 as never }); }, 0);
      return toolResult({ type: 'customer', changeScope: 'team' });
    });
    await expect(defineNewTrackerType('/ws', { type: 'customer', sharing: 'team' }))
      .rejects.toThrow('Someone else just created a type named "customer".');
  });

  // RV2-9: the push can be answered before defineNewTrackerType starts waiting.
  it('an acceptance that arrives before the wait starts is still a creation', async () => {
    mockDefineType.mockImplementation(async () => {
      publishTrackerSchemaOutcome('/ws', 'customer', { kind: 'settled', accepted: true });
      return toolResult({ type: 'customer', changeScope: 'team' });
    });
    await expect(defineNewTrackerType('/ws', { type: 'customer', sharing: 'team' }))
      .resolves.toEqual({ type: 'customer', scope: 'team', status: 'created' });
  });

  it('a lost race that arrives before the wait starts still retires the local file', async () => {
    mockDefineType.mockImplementation(async () => {
      publishTrackerSchemaOutcome('/ws', 'customer', { kind: 'settled', accepted: false, code: 'schemaExists', message: 'exists' });
      return toolResult({ type: 'customer', changeScope: 'team' });
    });
    await expect(defineNewTrackerType('/ws', { type: 'customer', sharing: 'team' }))
      .rejects.toThrow('Someone else just created a type named "customer".');
    expect(mockRetireFile).toHaveBeenCalledWith('/ws', 'customer');
  });

  it('says it is still syncing when the room has not answered in time', async () => {
    mockDefineType.mockResolvedValue(toolResult({ type: 'customer', changeScope: 'team' }));
    await expect(defineNewTrackerType('/ws', { type: 'customer', sharing: 'team' }, { outcomeTimeoutMs: 20 }))
      .resolves.toEqual({ type: 'customer', scope: 'team', status: 'syncing' });
  });

  it('refuses a type id that already exists and never calls the write', async () => {
    mockRegistryGet.mockImplementation((type: string) => (type === 'customer' ? { type: 'customer' } : undefined));
    await expect(defineNewTrackerType('/ws', { type: 'customer' })).rejects.toThrow('A type named "customer" already exists.');
    expect(mockDefineType).not.toHaveBeenCalled();
  });

  it('surfaces the write path refusal as an error', async () => {
    mockDefineType.mockResolvedValue({ content: [{ type: 'text', text: "Error: Tracker type 'customer' already exists." }], isError: true });
    await expect(defineNewTrackerType('/ws', { type: 'customer' })).rejects.toThrow("Tracker type 'customer' already exists.");
  });
});

// RV2-1: only a creation from the New type dialog must never reach an older room as a plain upsert.
describe('create-only mode on the desktop push', () => {
  beforeEach(() => {
    mockDefineType.mockReset();
    mockRegistryGet.mockReturnValue(undefined);
    mockRetireFile.mockClear();
    mockMarkRejected.mockClear();
  });

  it('sends a dialog-created team type as required, and an agent-created one as whenSupported', async () => {
    const hooks = createDesktopTrackerSchemaSyncHooks('/ws');
    mockListUnsynced.mockResolvedValue([
      { type: 'customer', model: '{}', deleted: false, createOnly: 'whenSupported' },
      { type: 'vendor', model: '{}', deleted: false, createOnly: 'whenSupported' },
    ]);
    mockDefineType.mockImplementation(async () => {
      const queued = await hooks.listUnsynced();
      expect(queued.map(row => [row.type, row.createOnly])).toEqual([['customer', 'required'], ['vendor', 'whenSupported']]);
      return toolResult({ type: 'customer', changeScope: 'team' });
    });
    await defineNewTrackerType('/ws', { type: 'customer', sharing: 'team' }, { outcomeTimeoutMs: 20 });
    expect(mockDefineType).toHaveBeenCalled();
  });

  it('against a room that cannot refuse an existing type, says the server must be updated and retires the row', async () => {
    const hooks = createDesktopTrackerSchemaSyncHooks('/ws');
    mockDefineType.mockImplementation(async () => {
      hooks.onSettled?.({
        type: 'customer', model: '{}', accepted: false,
        error: { code: 'createOnlyUnsupported', message: "This team's server must be updated before new types can be created here." },
      });
      return toolResult({ type: 'customer', changeScope: 'team' });
    });
    await expect(defineNewTrackerType('/ws', { type: 'customer', sharing: 'team' }))
      .rejects.toThrow('server must be updated');
    await vi.waitFor(() => expect(mockMarkRejected).toHaveBeenCalledWith('/ws', 'customer'));
    await vi.waitFor(() => expect(mockRetireFile).toHaveBeenCalledWith('/ws', 'customer'));

    // Once settled, the type is no longer a dialog creation: a later row is not upgraded.
    mockListUnsynced.mockResolvedValue([{ type: 'customer', model: '{}', deleted: false, createOnly: 'whenSupported' }]);
    expect((await hooks.listUnsynced())[0].createOnly).toBe('whenSupported');
  });
});
