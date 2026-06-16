/**
 * Live-mode discovery file for the `nim` companion CLI.
 *
 * The MCP bearer token is generated per-launch and held in memory only
 * (mcpAuth.ts) — it "dies with the process" and is not otherwise discoverable.
 * To let an out-of-process CLI talk to a *running* Nimbalyst over the loopback
 * MCP-HTTP server, we write a small, user-only-readable descriptor at startup
 * and delete it on quit:
 *
 *   <userData>/mcp-endpoint.json  (mode 0600)
 *   { pid, port, token, startedAt, schemaVersion?, workspaces: [{ path, name }] }
 *
 * Security: 0600, loopback-only server, pid-liveness checked by the reader, and
 * the token is already the app's CORS/loopback mitigation. The CLI confirms the
 * pid is alive before trusting a descriptor (a crash can leave a stale file).
 */
import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';

export interface EndpointWorkspace {
  path: string;
  name?: string;
}

export interface WriteDescriptorParams {
  port: number;
  token: string;
  schemaVersion?: number;
  workspaces?: EndpointWorkspace[];
}

function descriptorPath(): string {
  return path.join(app.getPath('userData'), 'mcp-endpoint.json');
}

/** Write (or rewrite) the endpoint descriptor. Best-effort: never throws. */
export function writeMcpEndpointDescriptor(params: WriteDescriptorParams): void {
  try {
    const payload = {
      pid: process.pid,
      port: params.port,
      token: params.token,
      startedAt: new Date().toISOString(),
      schemaVersion: params.schemaVersion,
      workspaces: params.workspaces ?? [],
    };
    const file = descriptorPath();
    // Write with 0600 so only the user can read the token.
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), { mode: 0o600 });
    // writeFileSync's mode only applies on create; enforce on existing files too.
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* non-fatal */
    }
    logger.mcp.info('Wrote MCP endpoint descriptor for nim CLI', file);
  } catch (err) {
    logger.mcp.error('Failed to write MCP endpoint descriptor:', err);
  }
}

/** Remove the descriptor on quit. Best-effort: never throws. */
export function removeMcpEndpointDescriptor(): void {
  try {
    fs.rmSync(descriptorPath(), { force: true });
  } catch {
    /* non-fatal */
  }
}
