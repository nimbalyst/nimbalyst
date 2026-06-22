import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockQuery,
  mockRegistry,
  mockHandleTrackerCreate,
  mockHandleTrackerUpdate,
} = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockRegistry: {
    fetchSnapshot: vi.fn(),
    findLocalIdByUrn: vi.fn(),
    getContribution: vi.fn(),
  },
  mockHandleTrackerCreate: vi.fn(),
  mockHandleTrackerUpdate: vi.fn(),
}));

vi.mock('../../../database/initialize', () => ({
  getDatabase: () => ({
    query: mockQuery,
  }),
}));

vi.mock('../TrackerImporterRegistry', () => ({
  getTrackerImporterRegistry: () => mockRegistry,
}));

vi.mock('../../../mcp/tools/trackerToolHandlers', () => ({
  handleTrackerCreate: mockHandleTrackerCreate,
  handleTrackerUpdate: mockHandleTrackerUpdate,
}));

import { getTrackerImportService, importedItemId } from '../TrackerImportService';

const workspacePath = '/tmp/ws';
const urn = 'github://nimbalyst/editor#42';
const external = {
  providerId: 'github-issues',
  externalId: 'nimbalyst/editor#42',
  urn,
  url: 'https://github.com/nimbalyst/editor/issues/42',
  titleSnapshot: 'Imported bug',
  stateSnapshot: 'open',
};

describe('TrackerImportService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRegistry.getContribution.mockResolvedValue({ importsAs: ['bug'] });
    mockHandleTrackerCreate.mockResolvedValue({
      isError: false,
      content: [{ type: 'text', text: '{}' }],
    });
    mockHandleTrackerUpdate.mockResolvedValue({
      isError: false,
      content: [{ type: 'text', text: '{}' }],
    });
  });

  it('imports snapshots through tracker_create with the upstream body as description', async () => {
    mockRegistry.fetchSnapshot.mockResolvedValue({
      external: { ...external },
      title: 'Imported bug',
      body: '## Details\n\n- first\n- second\n\nSee [docs](https://example.com).',
      status: 'open',
      labels: ['sync'],
    });
    mockRegistry.findLocalIdByUrn.mockResolvedValue(null);

    const result = await getTrackerImportService().runImport({
      workspacePath,
      providerId: 'github-issues',
      externalId: 'nimbalyst/editor#42',
    });

    const expectedId = importedItemId(urn);
    expect(result).toEqual({ id: expectedId, urn, created: true });
    expect(mockHandleTrackerCreate).toHaveBeenCalledTimes(1);
    expect(mockHandleTrackerCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expectedId,
        type: 'bug',
        title: 'Imported bug',
        description: '## Details\n\n- first\n- second\n\nSee [docs](https://example.com).',
        status: 'to-do',
        labels: ['sync'],
        createdByAgent: false,
      }),
      workspacePath,
    );

    const createArgs = mockHandleTrackerCreate.mock.calls[0][0];
    expect(createArgs.origin.kind).toBe('external');
    expect(createArgs.origin.external.urn).toBe(urn);
    expect(createArgs.origin.external.bodyHash).toMatch(/^[0-9a-f]{40}$/);
    expect(createArgs.origin.external.upstreamBodyChanged).toBe(false);
  });

  it('applies upstream body through tracker_update so body cache and Y.Doc seeding run', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: importedItemId(urn),
        data: JSON.stringify({
          title: 'Imported bug',
          status: 'to-do',
          labels: ['sync'],
          origin: {
            kind: 'external',
            external: {
              ...external,
              bodyHash: 'oldhash',
              upstreamBodyChanged: true,
            },
          },
        }),
      }],
    });
    mockRegistry.fetchSnapshot.mockResolvedValue({
      external: { ...external },
      title: 'Imported bug',
      body: 'Updated upstream body',
      status: 'open',
      labels: ['sync'],
    });

    await getTrackerImportService().applyUpstreamBody({ workspacePath, urn });

    expect(mockHandleTrackerUpdate).toHaveBeenCalledTimes(1);
    expect(mockHandleTrackerUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        id: importedItemId(urn),
        description: 'Updated upstream body',
        origin: expect.objectContaining({
          kind: 'external',
          external: expect.objectContaining({
            urn,
            bodyHash: expect.stringMatching(/^[0-9a-f]{40}$/),
            upstreamBodyChanged: false,
          }),
        }),
      }),
      workspacePath,
    );
  });
});
