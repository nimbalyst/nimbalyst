import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

class ControlError extends Error {
  constructor(code, reason) { super(reason); this.code = code; this.reason = reason; }
}

/** Only fixed codes/reasons cross the child boundary; raw diagnostics stay private. */
export function controlFailure(error) {
  if (error instanceof ControlError) return { success: false, error: error.code, reason: error.reason };
  const reason = error?.message;
  if (['invalid-path', 'invalid-request', 'node-not-provisioned', 'node-start-failed', 'grant-failed'].includes(reason)) {
    return { success: false, error: reason.startsWith('node-') || reason === 'grant-failed' ? reason : 'unknown', reason };
  }
  if (/not authenticated|not logged in|authentication error|invalid_grant|token.*expired/i.test(String(error?.message ?? ''))) {
    return { success: false, error: 'not-authenticated', reason: 'authentication' };
  }
  return { success: false, error: 'container-unavailable', reason: 'rpc-failed' };
}

const CONTROL_CONFIG_KEYS = ['name', 'account_id', 'compatibility_date', 'compatibility_flags', 'services'];

/**
 * Total over any parsed JSON. Rejecting only unexpected top-level keys left
 * malformed values to throw out of validation, and a thrown property access
 * classifies as `container-unavailable` -- blaming the sandbox for a config the
 * desktop generated. Anything we cannot read is invalid configuration.
 */
function isPrivateControlConfig(config) {
  try {
    const [service] = config.services;
    return Object.keys(config).every(key => CONTROL_CONFIG_KEYS.includes(key))
      && /^[a-f0-9]{32}$/.test(config.account_id ?? '')
      && /^\d{4}-\d{2}-\d{2}$/.test(config.compatibility_date ?? '')
      && config.services.length === 1
      && service.binding === 'Manager'
      && service.entrypoint === 'SandboxManager'
      && service.remote === true
      && /^[a-z0-9][a-z0-9-]{0,62}$/.test(service.service ?? '');
  } catch {
    return false;
  }
}

/** The desktop verifies Wrangler profile cwd and sanitizes the child environment. */
export async function runManagerRPC(request, createProxy) {
  if (!request || !['status', 'wake', 'stop', 'provision', 'startNode', 'nodeStatus', 'stopNode'].includes(request.operation)) {
    throw new ControlError('unknown', 'invalid-operation');
  }
  if (request.operation === 'stop' && request.discardEphemeralData !== true) {
    throw new ControlError('confirmation-required', 'confirmation-required');
  }
  if (request.operation === 'stopNode' && request.request?.discardEphemeralData !== true) {
    throw new ControlError('confirmation-required', 'confirmation-required');
  }
  if (typeof request.configPath !== 'string' || !isAbsolute(request.configPath)) {
    throw new ControlError('unknown', 'invalid-config');
  }
  let config;
  try { config = JSON.parse(await readFile(request.configPath, 'utf8')); }
  catch { throw new ControlError('unknown', 'invalid-config'); }
  if (!isPrivateControlConfig(config)) throw new ControlError('unknown', 'invalid-config');
  const proxy = await createProxy({ configPath: request.configPath, persist: false, envFiles: [], remoteBindings: true });
  try {
    const manager = proxy.env.Manager;
    const result = request.operation === 'stop'
      ? await manager.stop({ discardEphemeralData: true })
      : ['provision', 'startNode', 'stopNode'].includes(request.operation)
        ? await manager[request.operation](request.request)
        : await manager[request.operation]();
    // With remote bindings the result is a Miniflare stub, and dispose() below
    // poisons every stub. Copy the fields out while they can still be read;
    // returning the stub itself made every successful RPC look unreachable.
    return JSON.parse(JSON.stringify(result));
  } finally {
    await proxy.dispose();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  // Wrangler owns OAuth. Its diagnostic output can contain authentication
  // details; emit only our bounded protocol response, never its raw logs.
  const writeResult = process.stdout.write.bind(process.stdout);
  process.stdout.write = process.stderr.write = (_chunk, encoding, callback) => {
    const done = typeof encoding === 'function' ? encoding : callback;
    if (done) queueMicrotask(done);
    return true;
  };
  try {
    // The parent must end stdin after the single request. setEncoding retains
    // partial UTF-8 characters between chunks (profile paths may be non-ASCII).
    process.stdin.setEncoding('utf8');
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk;
    }
    let request;
    try { request = JSON.parse(input); }
    catch { throw new ControlError('unknown', 'invalid-request'); }
    // `null` and bare scalars parse fine; reading a field off them throws, and a
    // throw here would be reported as an unavailable container.
    if (!request || typeof request !== 'object') throw new ControlError('unknown', 'invalid-request');
    if (typeof request.wranglerModulePath !== 'string' || !isAbsolute(request.wranglerModulePath)) {
      throw new ControlError('wrangler-missing', 'wrangler-module');
    }
    let wrangler;
    try { wrangler = await import(pathToFileURL(request.wranglerModulePath).href); }
    catch { throw new ControlError('wrangler-unsupported', 'wrangler-module'); }
    if (typeof wrangler.getPlatformProxy !== 'function') throw new ControlError('wrangler-unsupported', 'wrangler-module');
    const data = await runManagerRPC(request, wrangler.getPlatformProxy);
    writeResult(`${JSON.stringify({ success: true, data })}\n`);
  } catch (error) {
    writeResult(`${JSON.stringify(controlFailure(error))}\n`);
    process.exitCode = 1;
  }
}
