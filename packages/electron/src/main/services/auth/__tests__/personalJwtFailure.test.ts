import { describe, expect, it } from 'vitest';

import {
  describePersonalJwtFailure,
  describeTransportError,
  isTransportError,
} from '../personalJwtFailure';

const SERVER_URL = 'ws://localhost:8790';
const EXPIRY_MS = Date.parse('2026-07-27T03:17:50.000Z');

describe('describePersonalJwtFailure', () => {
  it('reports an unreachable sync server as a connectivity failure, not an auth failure', () => {
    const err = describePersonalJwtFailure({
      reason: 'network',
      expiryMs: EXPIRY_MS,
      serverUrl: SERVER_URL,
    });

    // The whole point: an unreachable collab worker must not be reported as a
    // token/refresh problem. That misclassification is what sent multiple
    // investigations hunting a JWT bug that did not exist.
    expect((err as { code?: string }).code).toBe('SYNC_SERVER_UNREACHABLE');
    expect(err.message).toContain(SERVER_URL);
    expect(err.message).toMatch(/unreachable/i);
    expect(err.message).not.toMatch(/refresh did not produce a fresh one/);
  });

  it('still reports a server-confirmed refresh rejection as an expired-JWT auth failure', () => {
    const err = describePersonalJwtFailure({
      reason: 'auth',
      expiryMs: EXPIRY_MS,
      serverUrl: SERVER_URL,
    });

    expect((err as { code?: string }).code).toBe('PERSONAL_JWT_EXPIRED');
    expect(err.message).toContain('2026-07-27T03:17:50.000Z');
    expect(err.message).toMatch(/refresh did not produce a fresh one/);
  });

  it('treats an unclassified failure as an auth failure so nothing is silently downgraded', () => {
    const err = describePersonalJwtFailure({
      reason: null,
      expiryMs: EXPIRY_MS,
      serverUrl: SERVER_URL,
    });

    expect((err as { code?: string }).code).toBe('PERSONAL_JWT_EXPIRED');
  });

  it('names the transport error in the message so the log diagnoses itself', () => {
    const err = describePersonalJwtFailure({
      reason: 'network',
      expiryMs: EXPIRY_MS,
      serverUrl: SERVER_URL,
      detail: 'ECONNREFUSED (connect ECONNREFUSED 127.0.0.1:8790)',
    });

    expect(err.message).toContain(SERVER_URL);
    expect(err.message).toContain('ECONNREFUSED');
    expect(err.message).toContain('127.0.0.1:8790');
  });
});

/**
 * These are the failure shapes a desktop client actually produces against an
 * unreachable or flaky collab worker. Every one of them must classify as
 * transport: reporting any of them as an auth/JWT failure is the exact
 * misdiagnosis that sent two investigations after a token bug that never existed.
 */
describe('isTransportError', () => {
  const TRANSPORT_CASES: ReadonlyArray<[string, unknown]> = [
    [
      'Electron net.fetch connection refused',
      new TypeError('net::ERR_CONNECTION_REFUSED'),
    ],
    [
      'undici fetch failed wrapping ECONNREFUSED',
      Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8790'), {
          code: 'ECONNREFUSED',
        }),
      }),
    ],
    [
      'connection timeout',
      Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' }),
    ],
    [
      'connection timeout (posix code)',
      Object.assign(new Error('connect ETIMEDOUT 10.0.0.1:443'), { code: 'ETIMEDOUT' }),
    ],
    [
      'request aborted by a timeout signal',
      Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }),
    ],
    [
      'DNS failure (name not resolved)',
      Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('getaddrinfo ENOTFOUND sync.nimbalyst.com'), {
          code: 'ENOTFOUND',
        }),
      }),
    ],
    [
      'DNS failure (Electron)',
      new TypeError('net::ERR_NAME_NOT_RESOLVED'),
    ],
    [
      'DNS temporary failure',
      Object.assign(new Error('getaddrinfo EAI_AGAIN sync.nimbalyst.com'), { code: 'EAI_AGAIN' }),
    ],
    [
      'abrupt socket close mid-handshake',
      Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
      }),
    ],
    [
      'socket terminated before the response completed',
      Object.assign(new TypeError('terminated'), {
        cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
      }),
    ],
    [
      'the legacy isNetworkError tag still counts',
      Object.assign(new Error('Network error during session refresh'), { isNetworkError: true }),
    ],
  ];

  it.each(TRANSPORT_CASES)('classifies %s as transport', (_label, error) => {
    expect(isTransportError(error)).toBe(true);
  });

  const AUTH_CASES: ReadonlyArray<[string, unknown]> = [
    ['a server-confirmed rejection', new Error('Personal session refresh failed: 401')],
    ['an invalid JWT response', new Error('Personal session refresh returned invalid JWT')],
    ['a JSON parse failure on a real response', new SyntaxError('Unexpected token < in JSON at position 0')],
  ];

  it.each(AUTH_CASES)('does NOT classify %s as transport', (_label, error) => {
    expect(isTransportError(error)).toBe(false);
  });

  /**
   * The inverse misclassification, and the worse one. Reading a real 401 as
   * transport makes the caller retry forever behind a "server unreachable" log
   * line and never tell the user to re-authenticate. Each of these returned
   * `true` before the classifier looked for HTTP status evidence first.
   *
   * `net.fetch` resolves ordinary HTTP 401 responses rather than rejecting, so
   * these shapes come from wrappers -- our own timeout, undici's `fetch
   * failed`, a helper that rethrows with the status attached. The contract has
   * to hold for those callers, not just the one fetch we control today.
   */
  const AUTH_WEARING_TRANSPORT_CLOTHES: ReadonlyArray<[string, unknown]> = [
    [
      'a 401 whose message also says "network error"',
      Object.assign(new Error('HTTP 401 Unauthorized: network error while reading the response body'), {
        status: 401,
      }),
    ],
    [
      'a 401 nested under undici\'s generic "fetch failed" wrapper',
      Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('HTTP 401 Unauthorized'), { status: 401 }),
      }),
    ],
    [
      'our own timeout AbortError wrapping a server 401',
      Object.assign(new Error('The operation was aborted'), {
        name: 'AbortError',
        cause: Object.assign(new Error('HTTP 401 Unauthorized'), { status: 401 }),
      }),
    ],
  ];

  it.each(AUTH_WEARING_TRANSPORT_CLOTHES)('does NOT classify %s as transport', (_label, error) => {
    expect(isTransportError(error)).toBe(false);
  });

  const OTHER_AUTH_STATUS_SHAPES: ReadonlyArray<[string, unknown]> = [
    ['a 403 on `statusCode`', Object.assign(new TypeError('fetch failed'), { statusCode: 403 })],
    ['a 401 on `status_code` (Stytch wire shape)', Object.assign(new Error('network error'), { status_code: 401 })],
    ['a 401 on a nested `response`', Object.assign(new TypeError('fetch failed'), { response: { status: 401 } })],
    ['a 401 as a numeric string', Object.assign(new Error('network error'), { status: '401' })],
    [
      'a bare "fetch failed" with nothing to corroborate it',
      new TypeError('fetch failed'),
    ],
    [
      'a "network error" wrapper with no code and auth wording',
      new Error('Unauthorized: network error'),
    ],
  ];

  it.each(OTHER_AUTH_STATUS_SHAPES)('does NOT classify %s as transport', (_label, error) => {
    expect(isTransportError(error)).toBe(false);
  });

  /**
   * The counter-direction. Narrowing the predicate until a genuine
   * ECONNREFUSED reads as auth would reintroduce the original bug -- an
   * unreachable collab worker reported as an expiring JWT. Real transport
   * evidence must still win, including alongside a non-auth HTTP status or
   * auth-flavoured wording.
   */
  const STILL_TRANSPORT_UNDER_PRESSURE: ReadonlyArray<[string, unknown]> = [
    [
      'ECONNREFUSED carrying a non-auth status (502 from a proxy hop)',
      Object.assign(new TypeError('fetch failed'), {
        status: 502,
        cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8790'), { code: 'ECONNREFUSED' }),
      }),
    ],
    [
      'ECONNREFUSED under a wrapper whose message mentions the auth endpoint',
      Object.assign(new Error('Unauthorized-endpoint refresh failed'), {
        cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8790'), { code: 'ECONNREFUSED' }),
      }),
    ],
    [
      'a Chromium net error alongside auth wording',
      new TypeError('net::ERR_CONNECTION_REFUSED while calling /auth/refresh (unauthorized?)'),
    ],
    [
      'ENOTFOUND against a host whose port digits look like a status code',
      Object.assign(new Error('getaddrinfo ENOTFOUND sync.nimbalyst.com:8401'), { code: 'ENOTFOUND' }),
    ],
  ];

  it.each(STILL_TRANSPORT_UNDER_PRESSURE)('still classifies %s as transport', (_label, error) => {
    expect(isTransportError(error)).toBe(true);
  });
});

describe('describeTransportError', () => {
  it('surfaces the nested cause code and message from an undici-wrapped failure', () => {
    const error = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8790'), {
        code: 'ECONNREFUSED',
      }),
    });

    // The port matters: it is what tells the reader the client is pointed at a
    // local dev collab server that is not running.
    expect(describeTransportError(error)).toContain('ECONNREFUSED');
    expect(describeTransportError(error)).toContain('127.0.0.1:8790');
  });

  it('falls back to the message when there is no code', () => {
    expect(describeTransportError(new TypeError('net::ERR_CONNECTION_REFUSED')))
      .toBe('net::ERR_CONNECTION_REFUSED');
  });

  it('never throws on a non-error value', () => {
    expect(describeTransportError(undefined)).toBe('unknown transport error');
    expect(describeTransportError('boom')).toBe('unknown transport error');
  });
});
