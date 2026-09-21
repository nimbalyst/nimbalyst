// @vitest-environment node
/**
 * Enterprise MCP lockdown detection (NIM-2372).
 *
 * When `managed-mcp.json` is present the `claude` binary refuses BOTH
 * `--strict-mcp-config` and any dynamically-passed MCP server that isn't the
 * VS Code extension's own sdk server — so Nimbalyst must detect it and launch
 * without a snapshot rather than dying on exit 1.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetEnterpriseManagedMcpConfigCache,
  hasEnterpriseManagedMcpConfig,
  resolveEnterpriseManagedMcpConfigPath,
} from '../enterpriseMcpConfig';

beforeEach(() => {
  __resetEnterpriseManagedMcpConfigCache();
});

describe('resolveEnterpriseManagedMcpConfigPath', () => {
  it('mirrors the binary’s managed-settings roots per platform', () => {
    expect(resolveEnterpriseManagedMcpConfigPath('darwin')).toBe(
      '/Library/Application Support/ClaudeCode/managed-mcp.json'
    );
    expect(resolveEnterpriseManagedMcpConfigPath('win32')).toBe(
      'C:\\Program Files\\ClaudeCode\\managed-mcp.json'
    );
    expect(resolveEnterpriseManagedMcpConfigPath('linux')).toBe('/etc/claude-code/managed-mcp.json');
  });
});

describe('hasEnterpriseManagedMcpConfig', () => {
  it('keeps managed MCP control for malformed files and disables it only when absent', () => {
    const read = (contents: string | null) => ({ platform: 'darwin' as const, readFile: () => contents });

    expect(hasEnterpriseManagedMcpConfig(read('{"mcpServers":{}}'))).toBe(true);
    __resetEnterpriseManagedMcpConfigCache();
    expect(hasEnterpriseManagedMcpConfig(read(null))).toBe(false);
    __resetEnterpriseManagedMcpConfigCache();
    // CLI 2.1.271 retains exclusive control even when the config cannot parse.
    expect(hasEnterpriseManagedMcpConfig(read('{not json'))).toBe(true);
  });

  it.each(['EACCES', 'EPERM', 'EISDIR'])('keeps managed MCP control when reading fails with %s', code => {
    expect(hasEnterpriseManagedMcpConfig({ readFile: () => { throw Object.assign(new Error('Cannot read managed config'), { code }); } })).toBe(true);
  });

  it('treats a missing managed file as unrestricted', () => {
    expect(hasEnterpriseManagedMcpConfig({ readFile: () => { throw Object.assign(new Error('Missing'), { code: 'ENOENT' }); } })).toBe(false);
  });

  it('caches the probe (the file cannot appear mid-session without an IT push + restart)', () => {
    let reads = 0;
    const deps = {
      platform: 'linux' as const,
      readFile: () => {
        reads += 1;
        return '{}';
      },
    };
    expect(hasEnterpriseManagedMcpConfig(deps)).toBe(true);
    expect(hasEnterpriseManagedMcpConfig(deps)).toBe(true);
    expect(reads).toBe(1);
  });
});
