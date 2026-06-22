import { afterEach, describe, expect, it, vi } from 'vitest';

// Reproduce the production "doesn't stop thinking" hang at the transport layer.
//
// node's https.request `timeout` option is a SOCKET-INACTIVITY timer: it only
// fires after timeoutMs of no bytes on the socket. A language server that accepts
// the POST and then holds the connection open during a slow or wedged inference
// keeps the socket "active" enough that the 'timeout' event never fires, so the
// request promise never settles and the agent turn hangs forever on "Thinking...".
//
// rpc() now arms an independent hard wall-clock timer that fires on elapsed time
// regardless of socket activity. This mock NEVER emits 'response', 'end', or
// 'timeout' -- exactly the hang -- and asserts the hard timer still rejects with
// a "timed out" error (which the retry/agent loop then turns into a settled turn).
const onError = { fn: null as null | ((e: Error) => void) };

vi.mock('https', () => ({
  request: (_opts: unknown, _cb: unknown) => {
    const req = {
      on(ev: string, h: (e: Error) => void) {
        // We register the 'error' handler but DELIBERATELY never invoke the
        // 'timeout' handler -- the socket never goes idle in node's accounting.
        if (ev === 'error') onError.fn = h;
        return req;
      },
      write() {
        /* no-op: request body accepted */
      },
      end() {
        /* no-op: server never responds */
      },
      destroy(err: Error) {
        onError.fn?.(err);
      },
    };
    return req;
  },
}));

// Imported AFTER vi.mock so ServerManager's `import * as https` binds the mock.
import { AntigravityServerManager } from '../ServerManager';

function freshManager(): AntigravityServerManager {
  (AntigravityServerManager as unknown as { instance: unknown }).instance = null;
  return AntigravityServerManager.shared();
}

afterEach(() => {
  onError.fn = null;
  vi.restoreAllMocks();
});

describe('AntigravityServerManager.rpc hard wall-clock timeout', () => {
  it('rejects with "timed out" when the socket never responds and never fires the inactivity timeout', async () => {
    const m = freshManager();
    const ep = { httpsPort: 1, csrf: 'x', owned: true };
    const start = Date.now();
    // rpc is private; call it directly to isolate the transport timer.
    const rpc = (
      m as unknown as {
        rpc: (method: string, body: unknown, ep: unknown, t: number) => Promise<unknown>;
      }
    ).rpc.bind(m);
    await expect(rpc('GetModelResponse', { prompt: 'p' }, ep, 80)).rejects.toThrow(/timed out/);
    // The hard timer fired near the deadline -- not hung indefinitely.
    expect(Date.now() - start).toBeLessThan(2000);
  });
});
