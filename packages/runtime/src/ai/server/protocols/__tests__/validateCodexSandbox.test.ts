// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { validateCodexSandbox } from '../codexAppServer/validateCodexSandbox';
import type { JsonRpcClient } from '../codexAppServer/jsonRpcClient';

it.each([null, undefined, { type: 'futurePolicy' }, { type: 'dangerFullAccess' }])('rejects an unexpected policy: %j', async sandbox => {
  const request = vi.fn();
  await expect(validateCodexSandbox(sandbox, 'workspace-write', { request })).rejects.toThrow(/incompatible/);
  expect(request).not.toHaveBeenCalled();
});

it('distinguishes managed read-only policy from missing Windows setup', async () => {
  const request = vi.fn().mockResolvedValueOnce({ requirements: { allowedSandboxModes: ['read-only'] } });
  const client = { request } as Pick<JsonRpcClient, 'request'>;
  await expect(validateCodexSandbox({ type: 'readOnly' }, 'workspace-write', client, 'win32')).rejects.toThrow(/administrator/);
  expect(request).toHaveBeenCalledTimes(1);
  request.mockResolvedValueOnce({ requirements: { allowedSandboxModes: ['workspace-write'] } }).mockResolvedValueOnce({ status: 'notConfigured' });
  await expect(validateCodexSandbox({ type: 'readOnly' }, 'workspace-write', client, 'win32')).rejects.toThrow(/Settings > OpenAI Codex/);
});

it('accepts explicit unrestricted access without checking Windows setup', async () => {
  const request = vi.fn();
  await validateCodexSandbox({ type: 'dangerFullAccess' }, 'danger-full-access', { request }, 'win32');
  expect(request).not.toHaveBeenCalled();
});
