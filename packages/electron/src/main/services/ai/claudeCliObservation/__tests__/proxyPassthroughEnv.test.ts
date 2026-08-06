import { describe, it, expect } from 'vitest';
import {
  ASSUME_FIRST_PARTY_BASE_URL_ENV,
  buildProxyPassthroughEnv,
} from '../proxyPassthroughEnv';

/**
 * The observation proxy sits on `ANTHROPIC_BASE_URL`, which the CLI reads as
 * "this is an inference gateway" and uses to withhold first-party-only behavior
 * (the small/fast model for the web-tool side query, the 1M auto-upgrade).
 * `buildProxyPassthroughEnv` declares the proxy first-party, but only when the
 * bytes really do go to Anthropic.
 */
describe('buildProxyPassthroughEnv', () => {
  it('declares the proxy first-party when there is no custom upstream', () => {
    expect(buildProxyPassthroughEnv(undefined)).toEqual({
      [ASSUME_FIRST_PARTY_BASE_URL_ENV]: '1',
    });
  });

  it('declares the proxy first-party when the upstream IS api.anthropic.com', () => {
    expect(buildProxyPassthroughEnv('https://api.anthropic.com')).toEqual({
      [ASSUME_FIRST_PARTY_BASE_URL_ENV]: '1',
    });
    expect(buildProxyPassthroughEnv('https://api.anthropic.com/')).toEqual({
      [ASSUME_FIRST_PARTY_BASE_URL_ENV]: '1',
    });
  });

  it('stays silent when a custom loopback upstream is configured', () => {
    // The user routed traffic through their own middleware (token compression,
    // cache, gateway). We cannot promise the CLI it is talking to Anthropic.
    expect(buildProxyPassthroughEnv('http://127.0.0.1:8787/anthropic')).toEqual({});
    expect(buildProxyPassthroughEnv('http://localhost:8787')).toEqual({});
  });

  it('stays silent on an unparseable upstream rather than guessing', () => {
    expect(buildProxyPassthroughEnv('not a url')).toEqual({});
  });

  it('treats a blank upstream as unset', () => {
    expect(buildProxyPassthroughEnv('   ')).toEqual({
      [ASSUME_FIRST_PARTY_BASE_URL_ENV]: '1',
    });
  });
});
