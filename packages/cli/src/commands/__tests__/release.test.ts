/**
 * `nim release` is what the release script calls, so its two dangerous edges are
 * pinned here: it must never invent a release record, and it must never guess
 * which release to ship when several are open.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseArgs } from '../../cli/parse.js';
import { ExitCode, CliError } from '../../cli/exitCodes.js';
import type { TrackerRecord } from '../../vendor/trackerRecord.js';
import {
  findPendingReleases,
  releaseFinalizeFields,
  releaseNoteLines,
  renderReleaseNotes,
} from '../../vendor/trackerReleases.js';

const gatewayStub = {
  mode: 'live' as const,
  close: vi.fn(),
  listTrackers: vi.fn(async () => [] as TrackerRecord[]),
  getTracker: vi.fn(async () => null as TrackerRecord | null),
  updateTracker: vi.fn(async (_ws: string, ref: string) => record(ref, 'release')),
};

vi.mock('../common.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../common.js')>();
  return { ...actual, makeGateway: () => gatewayStub };
});
vi.mock('../../workspace/resolve.js', () => ({ resolveWorkspace: async () => '/ws' }));

const { runRelease } = await import('../release.js');

function record(
  id: string,
  primaryType: string,
  fields: Record<string, unknown> = {},
  overrides: Partial<TrackerRecord> = {},
): TrackerRecord {
  return {
    id,
    primaryType,
    typeTags: [primaryType],
    issueKey: `NIM-${id}`,
    source: 'native',
    archived: false,
    syncStatus: 'local',
    system: { workspace: '/ws', createdAt: '2026-07-20T00:00:00.000Z', updatedAt: '2026-07-20T00:00:00.000Z' },
    fields: { title: `Item ${id}`, ...fields },
  } as TrackerRecord;
}

let stdout: string;

beforeEach(() => {
  stdout = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  });
  gatewayStub.listTrackers.mockReset().mockResolvedValue([]);
  gatewayStub.getTracker.mockReset().mockResolvedValue(null);
  gatewayStub.updateTracker.mockReset().mockImplementation(async (_ws: string, ref: string) => record(ref, 'release'));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('nim release finalize', () => {
  it('fills the pending release rather than creating a record', async () => {
    gatewayStub.listTrackers.mockResolvedValue([record('next', 'release', { status: 'in-progress' })]);

    const code = await runRelease(parseArgs(['release', 'finalize', '--version', '0.71.0', '--channel', 'alpha']));

    expect(code).toBe(0);
    const [, reference, update] = gatewayStub.updateTracker.mock.calls[0];
    expect(reference).toBe('NIM-next');
    expect(update.status).toBe('released');
    expect(update.fields).toMatchObject({ version: '0.71.0', gitTag: 'v0.71.0', channel: 'alpha' });
    expect(update.fields.releasedAt).toBeTruthy();
  });

  it('refuses to guess when several releases are open', async () => {
    gatewayStub.listTrackers.mockResolvedValue([
      record('a', 'release', { status: 'planned' }),
      record('b', 'release', { status: 'planned' }),
    ]);

    await expect(runRelease(parseArgs(['release', 'finalize', '--version', '1.0.0'])))
      .rejects.toMatchObject({ code: ExitCode.USAGE });
    expect(gatewayStub.updateTracker).not.toHaveBeenCalled();
  });

  it('reports a missing release item instead of inventing one', async () => {
    gatewayStub.listTrackers.mockResolvedValue([record('shipped', 'release', { status: 'released' })]);

    await expect(runRelease(parseArgs(['release', 'finalize', '--version', '1.0.0'])))
      .rejects.toBeInstanceOf(CliError);
    expect(gatewayStub.updateTracker).not.toHaveBeenCalled();
  });

  it('requires a version', async () => {
    await expect(runRelease(parseArgs(['release', 'finalize'])))
      .rejects.toMatchObject({ code: ExitCode.USAGE });
  });

  it('rejects a named item that is not a release', async () => {
    gatewayStub.getTracker.mockResolvedValue(record('b1', 'bug'));

    await expect(runRelease(parseArgs(['release', 'finalize', 'NIM-b1', '--version', '1.0.0'])))
      .rejects.toMatchObject({ code: ExitCode.USAGE });
  });
});

describe('nim release notes', () => {
  it('renders the release members as changelog markdown', async () => {
    const bug = record('b1', 'bug');
    const release = record('next', 'release', {
      status: 'in-progress',
      items: [{ itemId: 'b1' }, { itemId: 'missing' }],
    });
    gatewayStub.listTrackers.mockImplementation(async (filters: { type?: string }) =>
      (filters.type === 'release' ? [release] : [release, bug]));

    const code = await runRelease(parseArgs(['release', 'notes']));

    expect(code).toBe(0);
    expect(stdout).toContain('### Bug');
    expect(stdout).toContain('- Item b1 (NIM-b1)');
    expect(stdout).not.toContain('missing');
  });
});

describe('release helpers', () => {
  it('defaults the tag to v<version> and stamps the date', () => {
    expect(releaseFinalizeFields({ version: '2.0.0' }, '2026-07-24T00:00:00.000Z')).toEqual({
      version: '2.0.0',
      gitTag: 'v2.0.0',
      releasedAt: '2026-07-24T00:00:00.000Z',
      status: 'released',
    });
  });

  it('ranks a started release ahead of a merely planned one', () => {
    const pending = findPendingReleases([
      record('planned', 'release', { status: 'planned' }),
      record('started', 'release', { status: 'in-progress' }),
    ]);
    expect(pending.map((r) => r.id)).toEqual(['started', 'planned']);
  });

  it('skips archived and unresolvable members', () => {
    const kept = record('k', 'bug');
    const archived = record('a', 'bug', {}, {});
    (archived as { archived: boolean }).archived = true;
    const release = record('r', 'release', { items: [{ itemId: 'k' }, { itemId: 'a' }, { itemId: 'gone' }] });

    const lines = releaseNoteLines(release, new Map([kept, archived].map((i) => [i.id, i])));
    expect(lines).toHaveLength(1);
    expect(renderReleaseNotes(lines)).toContain('- Item k (NIM-k)');
  });
});
