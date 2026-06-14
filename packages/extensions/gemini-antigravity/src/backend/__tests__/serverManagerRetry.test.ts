import { afterEach, describe, expect, it, vi } from 'vitest';
import { AntigravityServerManager, AntigravityVersionGateError } from '../ServerManager';

// getModelResponse retries the GetModelResponse RPC on a transport timeout, but
// ONLY when re-running ensureRunning() hands back a DIFFERENT endpoint (the old
// server crashed and was respawned). If the same alive-but-wedged server comes
// back, the wedge is this request -- not the process -- so re-issuing the same
// call would just burn another full timeout; we fail fast instead. It never
// retries a permanent version-gate error or an HTTP 4xx. These spy on the
// private rpc/ensureRunning so no real language server is spawned. Passing a
// 'MODEL_' key skips resolveModelEnum.
const EP1 = { httpsPort: 1, csrf: 'x', owned: true } as const;
const EP2 = { httpsPort: 2, csrf: 'x', owned: true } as const;

function freshManager(): AntigravityServerManager {
  (AntigravityServerManager as unknown as { instance: unknown }).instance = null;
  return AntigravityServerManager.shared();
}

afterEach(() => vi.restoreAllMocks());

describe('AntigravityServerManager.getModelResponse retry', () => {
  it('retries once when discovery returns a NEW endpoint, then succeeds', async () => {
    const m = freshManager();
    const ensure = vi
      .spyOn(m as never, 'ensureRunning')
      .mockResolvedValueOnce(EP1 as never)
      .mockResolvedValueOnce(EP2 as never);
    const rpc = vi
      .spyOn(m as never, 'rpc')
      .mockRejectedValueOnce(new Error('Antigravity GetModelResponse timed out'))
      .mockResolvedValueOnce({ response: 'ok answer' } as never);
    const out = await m.getModelResponse('p', 'MODEL_TEST', 1000);
    expect(out).toBe('ok answer');
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(ensure).toHaveBeenCalledTimes(2);
  });

  it('fails fast (no second RPC) when the same wedged endpoint comes back', async () => {
    const m = freshManager();
    // discovery hands back the SAME alive server on the retry: re-issuing the
    // identical request would hang again, so we throw the first timeout instead.
    vi.spyOn(m as never, 'ensureRunning').mockResolvedValue(EP1 as never);
    const rpc = vi
      .spyOn(m as never, 'rpc')
      .mockRejectedValue(new Error('Antigravity GetModelResponse timed out'));
    await expect(m.getModelResponse('p', 'MODEL_TEST', 1000)).rejects.toThrow(/timed out/);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('does not retry an HTTP 4xx', async () => {
    const m = freshManager();
    vi.spyOn(m as never, 'ensureRunning').mockResolvedValue(EP1 as never);
    const rpc = vi
      .spyOn(m as never, 'rpc')
      .mockRejectedValue(new Error('Antigravity GetModelResponse HTTP 403: forbidden'));
    await expect(m.getModelResponse('p', 'MODEL_TEST', 1000)).rejects.toThrow(/HTTP 403/);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('does not retry a version-gate error', async () => {
    const m = freshManager();
    vi.spyOn(m as never, 'ensureRunning').mockResolvedValue(EP1 as never);
    const rpc = vi
      .spyOn(m as never, 'rpc')
      .mockResolvedValue({ response: 'this build is no longer supported' } as never);
    await expect(m.getModelResponse('p', 'MODEL_TEST', 1000)).rejects.toBeInstanceOf(
      AntigravityVersionGateError,
    );
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('gives up after two timeouts across different endpoints', async () => {
    const m = freshManager();
    vi.spyOn(m as never, 'ensureRunning')
      .mockResolvedValueOnce(EP1 as never)
      .mockResolvedValueOnce(EP2 as never);
    const rpc = vi
      .spyOn(m as never, 'rpc')
      .mockRejectedValue(new Error('Antigravity GetModelResponse timed out'));
    await expect(m.getModelResponse('p', 'MODEL_TEST', 1000)).rejects.toThrow(/timed out/);
    expect(rpc).toHaveBeenCalledTimes(2);
  });
});
