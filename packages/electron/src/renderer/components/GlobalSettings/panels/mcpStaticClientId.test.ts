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

describe('withRedirectUri', () => {
  it('drops the oauth block when clearing the only setting, so a static-key server is not bridged', async () => {
    const { withRedirectUri } = await import('./mcpStaticClientId');
    expect(withRedirectUri({ redirectUri: 'http://localhost:4000/cb' }, ' ')).toBeUndefined();
    expect(withRedirectUri({ staticClientInfo: { client_id: 'abc' } }, 'http://localhost:4000/cb'))
      .toEqual({ staticClientInfo: { client_id: 'abc' }, redirectUri: 'http://localhost:4000/cb' });
  });

  it('accepts only http URIs with a port, which the local callback listener can serve', async () => {
    const { isUsableRedirectUri } = await import('./mcpStaticClientId');
    expect(isUsableRedirectUri('http://localhost:8765/oauth/callback')).toBe(true);
    expect(isUsableRedirectUri('https://localhost:8765/oauth/callback')).toBe(false);
    expect(isUsableRedirectUri('http://localhost/oauth/callback')).toBe(false);
    expect(isUsableRedirectUri('not a url')).toBe(false);
  });
});
