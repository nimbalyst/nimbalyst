// @vitest-environment node
/**
 * LiveGateway routes tracker writes through the in-app MCP server. NIM-857:
 * `defineType`/`deleteType` previously ignored `result.isError`, so when the
 * MCP tool failed (e.g. `tracker_delete_type` throwing "no such function: ANY"
 * on the SQLite backend) the CLI still printed a false "Deleted" success. These
 * tests pin the contract that a tool-level error surfaces as a thrown error.
 */
import { describe, it, expect, vi } from 'vitest';
import { LiveGateway } from '../LiveGateway.js';
import type { McpToolResult } from '../mcpClient.js';

function makeGateway(callTool: (...args: any[]) => Promise<McpToolResult>) {
  const gateway = new LiveGateway({ pid: 1, port: 1234, token: 'test-token' });
  // Replace the private MCP client with a stub so no real socket is opened.
  (gateway as any).client = { callTool: vi.fn(callTool) };
  return gateway;
}

describe('LiveGateway tool-error propagation (NIM-857)', () => {
  it('deleteType throws when the MCP tool returns isError', async () => {
    const gateway = makeGateway(async () => ({
      isError: true,
      summary: 'Error deleting tracker type: no such function: ANY',
      raw: {},
    }));

    await expect(gateway.deleteType('/tmp/ws', 'incident')).rejects.toThrow(/no such function: ANY/);
  });

  it('deleteType resolves when the MCP tool succeeds', async () => {
    const gateway = makeGateway(async () => ({
      isError: false,
      summary: "Deleted tracker type 'incident'.",
      structured: { action: 'deleted-type', type: 'incident' },
      raw: {},
    }));

    await expect(gateway.deleteType('/tmp/ws', 'incident')).resolves.toBeUndefined();
  });

  it('defineType throws when the MCP tool returns isError', async () => {
    const gateway = makeGateway(async () => ({
      isError: true,
      summary: 'Error defining tracker type: invalid schema',
      raw: {},
    }));

    await expect(
      gateway.defineType('/tmp/ws', { type: 'incident' }),
    ).rejects.toThrow(/invalid schema/);
  });

  it('defineType resolves when the MCP tool succeeds', async () => {
    const gateway = makeGateway(async () => ({
      isError: false,
      summary: "Defined tracker type 'incident'.",
      structured: { action: 'defined-type', type: 'incident' },
      raw: {},
    }));

    await expect(
      gateway.defineType('/tmp/ws', { type: 'incident' }),
    ).resolves.toBeUndefined();
  });
});

describe('LiveGateway tracker list adaptation', () => {
  it('forwards the all-items sentinel and preserves custom release fields', async () => {
    const callTool = vi.fn(async () => ({
      isError: false,
      summary: 'listed',
      structured: {
        items: [{
          id: 'release-1',
          issueKey: 'NIM-1',
          type: 'release',
          typeTags: ['release'],
          title: 'Next release',
          status: 'in-progress',
          customFields: {
            version: '0.71.0',
            items: [{ itemId: 'bug-1' }],
          },
        }],
      },
      raw: {},
    }));
    const gateway = makeGateway(callTool);

    const [release] = await gateway.listTrackers({
      workspace: '/ws',
      type: 'release',
      limit: -1,
    });

    // Always requests the full per-item payload: the CLI maps custom fields
    // (release version, members) that the lean agent default omits.
    expect(callTool).toHaveBeenCalledWith('/ws', 'tracker_list', {
      type: 'release',
      limit: -1,
      full: true,
    });
    expect(release.fields).toMatchObject({
      version: '0.71.0',
      items: [{ itemId: 'bug-1' }],
    });
  });

  // `--inbox` delegates to the MCP tool rather than reimplementing the
  // predicate, so an agent's queue and the app's inbox can't drift apart.
  it('forwards --inbox to the tracker_list tool', async () => {
    const callTool = vi.fn(async () => ({
      isError: false,
      summary: 'listed',
      structured: { items: [] },
      raw: {},
    }));
    const gateway = makeGateway(callTool);

    await gateway.listTrackers({ workspace: '/ws', inbox: true });

    expect(callTool).toHaveBeenCalledWith('/ws', 'tracker_list', { inbox: true, full: true });
  });
});

// MUL-26: `tracker_get` used to omit `archived` entirely, and the `?? false`
// below turned the absent key into a confident `false` -- so an archived item
// read back as active through `nim tracker get --json` permanently. Comments
// arrive as a top-level key (not in the customFields bag), so they need their
// own mapping or they land nowhere.
describe('LiveGateway tracker get adaptation', () => {
  function makeGetGateway(item: Record<string, unknown>) {
    return makeGateway(async () => ({
      isError: false,
      summary: 'retrieved',
      structured: { action: 'retrieved', item },
      raw: {},
    }));
  }

  it('carries archive and sync state through to the record', async () => {
    const gateway = makeGetGateway({
      id: 'bug-1',
      type: 'bug',
      title: 'Probe',
      archived: true,
      archivedAt: '2026-08-10T16:38:19.899Z',
      syncStatus: 'synced',
    });

    const record = await gateway.getTracker('/ws', 'bug-1');

    expect(record?.archived).toBe(true);
    expect(record?.syncStatus).toBe('synced');
  });

  it('maps top-level comments into the record fields', async () => {
    const gateway = makeGetGateway({
      id: 'bug-1',
      type: 'bug',
      title: 'Probe',
      comments: [{ id: 'comment_1', body: 'PROBE-XYZZY', deleted: false }],
    });

    const record = await gateway.getTracker('/ws', 'bug-1');

    expect(record?.fields.comments).toEqual([
      { id: 'comment_1', body: 'PROBE-XYZZY', deleted: false },
    ]);
  });

  it('leaves comments unset when the item carries none', async () => {
    const gateway = makeGetGateway({ id: 'bug-1', type: 'bug', title: 'Probe', comments: [] });

    const record = await gateway.getTracker('/ws', 'bug-1');

    expect(record?.fields.comments).toBeUndefined();
  });
});
