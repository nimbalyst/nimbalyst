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
});
