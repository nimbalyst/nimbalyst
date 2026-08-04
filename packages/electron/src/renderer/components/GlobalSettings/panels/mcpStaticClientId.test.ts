// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { withStaticClientId } from './mcpStaticClientId';

describe('withStaticClientId', () => {
  it('writes staticClientInfo, never the CLI-owned clientId', () => {
    const oauth = withStaticClientId(undefined, 'abc');
    expect(oauth).toEqual({ staticClientInfo: { client_id: 'abc' } });
    expect(oauth).not.toHaveProperty('clientId');
  });

  it('drops the oauth block entirely when the only setting is cleared', () => {
    // `oauth: {}` reads downstream as "this server requires OAuth", which would
    // wrap a plain static-key server in mcp-remote. Clearing must leave none.
    expect(withStaticClientId({ staticClientInfo: { client_id: 'abc' } }, '  ')).toBeUndefined();
  });

  it('preserves other oauth settings when the client id is cleared', () => {
    expect(withStaticClientId({ callbackPort: 3118, staticClientInfo: { client_id: 'abc' } }, ''))
      .toEqual({ callbackPort: 3118, staticClientInfo: undefined });
  });
});
