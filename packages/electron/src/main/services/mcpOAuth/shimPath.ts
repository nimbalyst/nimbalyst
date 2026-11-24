/**
 * Absolute path to `mcp-gateway-stdio.mjs`, the stdio bridge for CLIs that
 * only launch MCP servers as local processes. Shipped through
 * electron-builder `extraResources` (packaged: `<resourcesPath>/`), read from
 * the source tree in dev. Same layout as codex-pre-edit-hook.mjs.
 */
import { app } from 'electron';
import { existsSync } from 'fs';
import { join } from 'path';
import { getPackageRoot } from '../../utils/appPaths';

export const MCP_GATEWAY_SHIM_FILE = 'mcp-gateway-stdio.mjs';
export const MCP_GATEWAY_TOKEN_ENV = 'NIMBALYST_MCP_GATEWAY_TOKEN';

let override: string | null = null;

export function resolveMcpGatewayShimPath(): string | undefined {
  if (override) {
    return override;
  }
  const candidates: string[] = [];
  if (app.isPackaged) {
    if (process.resourcesPath) {
      candidates.push(join(process.resourcesPath, MCP_GATEWAY_SHIM_FILE));
      candidates.push(join(process.resourcesPath, 'resources', MCP_GATEWAY_SHIM_FILE));
    }
  } else {
    candidates.push(join(getPackageRoot(), 'resources', MCP_GATEWAY_SHIM_FILE));
  }
  return candidates.find((candidate) => existsSync(candidate));
}

export function setMcpGatewayShimPathForTest(path: string | null): void {
  override = path;
}
