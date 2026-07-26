import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCallTool = vi.fn();
vi.mock('../mcpClient.js', () => ({
  McpHttpClient: class {
    callTool = mockCallTool;
  },
}));

import { LiveGateway } from '../LiveGateway.js';
import { ExitCode } from '../../cli/exitCodes.js';

/**
 * A rejected write must fail loudly. Previously `createTracker` fabricated a
 * placeholder record and `updateTracker` re-fetched the unchanged item, so a
 * refused write was reported as a success.
 */
describe('LiveGateway surfaces rejected writes', () => {
  const gateway = () => new LiveGateway({ pid: 1, port: 3456, token: 't' } as any);
  const createInput = { type: 'plan', title: 'A plan' } as any;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws when create is rejected, rather than reporting a fabricated record', async () => {
    mockCallTool.mockResolvedValue({ isError: true, summary: "planId: Field 'planId' is required" });
    await expect(gateway().createTracker('/ws', createInput)).rejects.toThrow(/planId/);
  });

  it('exits with WRITE_NOT_PERMITTED when a write is refused', async () => {
    mockCallTool.mockResolvedValue({ isError: true, summary: 'refused' });
    await expect(gateway().createTracker('/ws', createInput)).rejects.toMatchObject({
      code: ExitCode.WRITE_NOT_PERMITTED,
    });
  });

  it('falls back to structured errors when no summary is given', async () => {
    mockCallTool.mockResolvedValue({ isError: true, structured: { errors: [{ message: 'bad status' }] } });
    await expect(gateway().createTracker('/ws', createInput)).rejects.toThrow(/bad status/);
  });

  it('throws when create reports success but persists no item', async () => {
    mockCallTool.mockResolvedValue({ isError: false, structured: {} });
    await expect(gateway().createTracker('/ws', createInput)).rejects.toThrow(/no item/);
  });

  it('throws when update is rejected, rather than returning the unchanged item', async () => {
    mockCallTool.mockResolvedValue({ isError: true, summary: 'invalid option: bogus' });
    await expect(gateway().updateTracker('/ws', 'NIM-1', { status: 'bogus' } as any)).rejects.toThrow(/invalid option/);
  });

  it('returns the created record when the write succeeds', async () => {
    mockCallTool.mockResolvedValue({ isError: false, structured: { item: { id: 'pln_1', type: 'plan', title: 'A plan' } } });
    const record = await gateway().createTracker('/ws', createInput);
    expect(record.id).toBe('pln_1');
  });
});
