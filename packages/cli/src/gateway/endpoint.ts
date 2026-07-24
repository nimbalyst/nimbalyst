/**
 * Live-mode discovery: read the endpoint descriptor the running app writes at
 * startup, confirm its pid is alive, and surface the loopback MCP endpoint.
 *
 * Descriptor (mode 0600), written to <userData>/mcp-endpoint.json:
 *   { pid, port, token, startedAt, schemaVersion, workspaces: [{ path, name }] }
 */
import * as fs from 'fs';
import { resolveEndpointDescriptorPath } from '../config/paths.js';

export interface EndpointDescriptor {
  pid: number;
  port: number;
  token: string;
  startedAt?: string;
  schemaVersion?: number;
  workspaces?: { path: string; name?: string }[];
}

/** Is a process with this pid currently alive? */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 performs error checking without actually sending a signal.
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    // EPERM means the process exists but we can't signal it — still alive.
    return err && err.code === 'EPERM';
  }
}

/**
 * Read + validate the descriptor. Returns null if absent, malformed, or owned by
 * a dead pid (in which case the caller falls back to direct mode).
 *
 * Env overrides NIM_ENDPOINT (host:port or full url) + NIM_TOKEN force live mode
 * without reading the file.
 */
export function discoverEndpoint(): EndpointDescriptor | null {
  const envEndpoint = process.env.NIM_ENDPOINT;
  const envToken = process.env.NIM_TOKEN;
  if (envEndpoint && envToken) {
    const port = parsePort(envEndpoint);
    if (port) {
      return { pid: 0, port, token: envToken };
    }
  }

  const file = resolveEndpointDescriptorPath();
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }

  let parsed: EndpointDescriptor;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed.port !== 'number' || typeof parsed.token !== 'string') {
    return null;
  }

  // A descriptor written with an explicit env override has pid 0; otherwise the
  // pid must be alive (the app deletes the file on clean quit, but a crash can
  // leave a stale descriptor behind).
  if (parsed.pid && !pidAlive(parsed.pid)) {
    return null;
  }

  return parsed;
}

function parsePort(endpoint: string): number | null {
  const m = endpoint.match(/(\d{2,5})\s*$/);
  if (!m) return null;
  const port = Number.parseInt(m[1], 10);
  return Number.isNaN(port) ? null : port;
}
