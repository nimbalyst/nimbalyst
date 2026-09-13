import { describe, expect, it } from 'vitest';
import { describeCodexConfigError } from '../codexConfigError';

describe('describeCodexConfigError', () => {
  const raw =
    'Codex Exec exited with code 1: Error loading config.toml: url is not supported for stdio in mcp_servers.linear';

  it('returns actionable guidance naming the offending server', () => {
    const msg = describeCodexConfigError(raw);
    expect(msg).not.toBeNull();
    expect(msg).toContain('"linear"');
    expect(msg).toContain('[mcp_servers.linear]');
    expect(msg).toContain('mixed transport');
    expect(msg).toContain('url = "<url>"');
    expect(msg).toContain('command = "<command>"');
  });

  it('shows mutually exclusive HTTP and stdio shapes', () => {
    const msg = describeCodexConfigError(
      'Error loading config.toml: url is not supported for stdio in mcp_servers.my-server'
    );
    expect(msg).toContain('[mcp_servers.my-server]');
    expect(msg).toContain('Streamable HTTP');
    expect(msg).toContain('local stdio');
  });

  it('quotes the TOML table key when the server name contains a dot', () => {
    const msg = describeCodexConfigError(
      'Error loading config.toml: url is not supported for stdio in mcp_servers.customer.io'
    );
    expect(msg).toContain('[mcp_servers."customer.io"]');
  });

  it('returns null for unrelated or empty errors', () => {
    expect(describeCodexConfigError('network error: ECONNREFUSED')).toBeNull();
    expect(describeCodexConfigError('Codex Exec exited with code 1')).toBeNull();
    expect(describeCodexConfigError('')).toBeNull();
  });
});
