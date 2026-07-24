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
    expect(msg).toContain('mcp-remote');
    expect(msg).toContain('Personal API Key');
    expect(msg).toContain('LINEAR_API_KEY');
  });

  it('derives the env var name from the server name', () => {
    const msg = describeCodexConfigError(
      'Error loading config.toml: url is not supported for stdio in mcp_servers.my-server'
    );
    expect(msg).toContain('[mcp_servers.my-server]');
    expect(msg).toContain('MY_SERVER_API_KEY');
  });

  it('quotes the TOML table key when the server name contains a dot', () => {
    const msg = describeCodexConfigError(
      'Error loading config.toml: url is not supported for stdio in mcp_servers.customer.io'
    );
    expect(msg).toContain('[mcp_servers."customer.io"]');
    expect(msg).toContain('[mcp_servers."customer.io".env]');
    expect(msg).toContain('CUSTOMER_IO_API_KEY');
  });

  it('returns null for unrelated or empty errors', () => {
    expect(describeCodexConfigError('network error: ECONNREFUSED')).toBeNull();
    expect(describeCodexConfigError('Codex Exec exited with code 1')).toBeNull();
    expect(describeCodexConfigError('')).toBeNull();
  });
});
