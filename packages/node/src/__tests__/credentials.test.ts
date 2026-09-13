// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CredentialRevokedError,
  createCredentialRefresher,
  readCredentialFile,
  writeCredentialFileAtomic,
  type NodeCredential,
} from '../serve/credentials.js';

const BASE: NodeCredential = {
  nodeId: 'node-1',
  userId: 'member-1',
  orgId: 'organization-1',
  refreshToken: 'refresh-v1',
  refreshExpiresAt: 4_000_000_000_000,
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as unknown as Response;
}

let directory: string;
let credentialPath: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'nimbalyst-node-credential-'));
  credentialPath = join(directory, 'node-credential.json');
  writeFileSync(credentialPath, JSON.stringify(BASE));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('node credential refresh', () => {
  it('persists the rotated refresh token before reporting the refresh complete', async () => {
    const order: string[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      order.push(`request:${JSON.parse(String(init?.body)).refresh_token}`);
      return jsonResponse(200, {
        access_token: 'nimnode_v1~kid~payload~sig',
        token_type: 'Bearer',
        expires_in: 900,
        refresh_token: 'refresh-v2',
        refresh_expires_at: 4_100_000_000_000,
        scope: 'personal',
        user_id: 'member-1',
        org_id: 'organization-1',
        node_id: 'node-1',
      });
    }) as unknown as typeof fetch;

    const refresher = createCredentialRefresher({
      serverUrl: 'https://sync.example.com/',
      credentialPath,
      fetchImpl,
      now: () => 1_000_000,
      writeCredential: (targetPath, credential) => {
        // Recorded relative to the resolve below: the token must be durable
        // before any caller can act on it. A crash here loses the ONLY usable
        // refresh token, because presenting the old one destroys the node.
        order.push(`write:${credential.refreshToken}`);
        writeCredentialFileAtomic(targetPath, credential);
      },
    });

    const token = await refresher.getAccessToken();
    order.push(`resolved:${token}`);

    expect(order).toEqual([
      // Phase 1: the marker goes down before the token is presented.
      'write:refresh-v1',
      'request:refresh-v1',
      // Phase 2: the replacement is durable before the caller sees it.
      'write:refresh-v2',
      'resolved:nimnode_v1~kid~payload~sig',
    ]);
    expect(readCredentialFile(credentialPath)).toMatchObject({
      refreshToken: 'refresh-v2',
      accessToken: 'nimnode_v1~kid~payload~sig',
      accessTokenExpiresAt: 1_000_000 + 900_000,
    });

    // A second call inside the validity window must not spend another rotation.
    await refresher.getAccessToken();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('treats HTTP 400 as revoked and never retries the rejected token', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(400, { error: 'invalid_grant' }),
    ) as unknown as typeof fetch;

    const refresher = createCredentialRefresher({ serverUrl: 'https://sync.example.com', credentialPath, fetchImpl });

    await expect(refresher.getAccessToken()).rejects.toBeInstanceOf(CredentialRevokedError);
    await expect(refresher.getAccessToken()).rejects.toMatchObject({ reason: 'invalid_grant' });

    // One request, ever. A confirmed revocation is latched, so a second ask
    // reports the same thing instead of presenting the rejected token again --
    // each presentation is another chance to destroy a replacement credential
    // the desktop has since issued. The on-disk token is untouched, so a
    // re-provisioning desktop is not racing a rewritten file.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(readCredentialFile(credentialPath).refreshToken).toBe('refresh-v1');
  });

  it('never presents a token it could not first mark as in flight', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, {})) as unknown as typeof fetch;
    const refresher = createCredentialRefresher({
      serverUrl: 'https://sync.example.com',
      credentialPath,
      fetchImpl,
      writeCredential: () => { throw new Error('read-only filesystem'); },
    });

    await expect(refresher.refresh()).rejects.toThrow(/read-only filesystem/);
    // Presenting a token we cannot record having presented is the exact
    // sequence that loses a credential to a crash. Better to fail loudly.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('takes the expiry from the token, not from expires_in against our own clock', async () => {
    // A real node access token: nimnode_v1~kid~base64url(claims)~sig.
    const expSeconds = 2_000_000_000;
    const claims = { v: 1, scope: 'personal', sub: 'member-1', org: 'organization-1', nid: 'node-1', iat: expSeconds - 900, exp: expSeconds };
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const accessToken = `nimnode_v1~kid1~${payload}~sig`;

    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: 900,
        refresh_token: 'refresh-v2',
        refresh_expires_at: 4_100_000_000_000,
        scope: 'personal',
        user_id: 'member-1',
        org_id: 'organization-1',
        node_id: 'node-1',
      }),
    ) as unknown as typeof fetch;

    // This node's clock is an hour behind the server that minted the token, so
    // `now + expires_in` would say the token is good long after CollabV3Sync's
    // ensureFreshJwt starts rejecting it on the token's own exp.
    const slowClock = () => (expSeconds - 3600) * 1000;
    const refresher = createCredentialRefresher({
      serverUrl: 'https://sync.example.com',
      credentialPath,
      fetchImpl,
      now: slowClock,
    });

    await refresher.getAccessToken();
    expect(refresher.accessTokenExpiresAt()).toBe(expSeconds * 1000);
    expect(readCredentialFile(credentialPath).accessTokenExpiresAt).toBe(expSeconds * 1000);
  });

  it('re-derives a stored token\'s expiry instead of trusting the number beside it', async () => {
    // A file whose accessTokenExpiresAt claims the far future while the token
    // itself is undecodable. Trusting the number would hand the provider a
    // credential it rejects locally; re-deriving forces a refresh instead.
    writeFileSync(credentialPath, JSON.stringify({
      ...BASE,
      accessToken: 'not-a-node-token',
      accessTokenExpiresAt: 4_000_000_000_000,
    }));

    const fetchImpl = vi.fn(async () =>
      jsonResponse(400, { error: 'invalid_grant' }),
    ) as unknown as typeof fetch;

    const refresher = createCredentialRefresher({ serverUrl: 'https://sync.example.com', credentialPath, fetchImpl });
    await expect(refresher.getAccessToken()).rejects.toBeInstanceOf(CredentialRevokedError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('marks the rotation in flight on disk BEFORE presenting the token', async () => {
    const order: string[] = [];
    const fetchImpl = vi.fn(async () => {
      // Everything the file says at the moment the token goes out. If the
      // process dies here, this is what the next one starts from.
      order.push(`request:marker=${readCredentialFile(credentialPath).refreshInFlightAt !== undefined}`);
      return jsonResponse(200, {
        access_token: 'access-v2', token_type: 'Bearer', expires_in: 900,
        refresh_token: 'refresh-v2', refresh_expires_at: 4_100_000_000_000,
        scope: 'personal', user_id: 'member-1', org_id: 'organization-1', node_id: 'node-1',
      });
    }) as unknown as typeof fetch;

    const refresher = createCredentialRefresher({
      serverUrl: 'https://sync.example.com', credentialPath, fetchImpl, now: () => 5_000,
    });

    await refresher.refresh();
    order.push('resolved');

    expect(order).toEqual(['request:marker=true', 'resolved']);
    // A completed rotation clears the marker; the file is a usable credential again.
    expect(readCredentialFile(credentialPath)).toMatchObject({
      refreshToken: 'refresh-v2',
      refreshInFlightAt: undefined,
    });
  });

  it('never replays a rotation a previous process left in flight', async () => {
    // Exactly what a crash between the response and the write leaves behind:
    // the marker, beside a refresh token the server may already have spent.
    // Phase 2 writes WITHOUT the marker, so a marker that survived proves the
    // replacement was never stored.
    writeCredentialFileAtomic(credentialPath, { ...BASE, refreshInFlightAt: 1_000 });

    const logged: string[] = [];
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        access_token: 'access-v2', token_type: 'Bearer', expires_in: 900,
        refresh_token: 'refresh-v2', refresh_expires_at: 4_100_000_000_000,
        scope: 'personal', user_id: 'member-1', org_id: 'organization-1', node_id: 'node-1',
      }),
    ) as unknown as typeof fetch;

    const refresher = createCredentialRefresher({
      serverUrl: 'https://sync.example.com',
      credentialPath,
      fetchImpl,
      log: (event) => logged.push(event),
    });

    // Presenting `refresh-v1` again is the one move that can destroy a
    // credential that is still alive. It is not made -- not even once, and not
    // even to find out.
    await expect(refresher.getAccessToken()).rejects.toMatchObject({
      reason: 'rotation_unresolved',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(logged).toContain('credential-rotation-unresolved');

    // Still terminal on a second ask; nothing about it becomes safer with time.
    await expect(refresher.refresh()).rejects.toBeInstanceOf(CredentialRevokedError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('is terminal, not transient, when the rotated credential cannot be stored', async () => {
    let allowWrite = true;
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        access_token: 'access-v2', token_type: 'Bearer', expires_in: 900,
        refresh_token: 'refresh-v2', refresh_expires_at: 4_100_000_000_000,
        scope: 'personal', user_id: 'member-1', org_id: 'organization-1', node_id: 'node-1',
      }),
    ) as unknown as typeof fetch;

    const refresher = createCredentialRefresher({
      serverUrl: 'https://sync.example.com',
      credentialPath,
      fetchImpl,
      writeCredential: (targetPath, credential) => {
        // The marker write succeeds; the write of the replacement fails.
        if (!allowWrite && credential.accessToken) throw new Error('read-only filesystem');
        writeCredentialFileAtomic(targetPath, credential);
      },
    });

    allowWrite = false;
    // The server rotated and we cannot store the result: the token on disk is
    // spent, so this node is already unrecoverable without the desktop. Exit 3
    // now rather than backing off forever on a credential that cannot work.
    await expect(refresher.refresh()).rejects.toMatchObject({ reason: 'rotation_unpersisted' });

    // And it must not run on a token no restart could reproduce.
    await expect(refresher.getAccessToken()).rejects.toBeInstanceOf(CredentialRevokedError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries a connection that was refused before the request could be sent', async () => {
    let reachable = false;
    const fetchImpl = vi.fn(async () => {
      if (!reachable) {
        throw Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' });
      }
      return jsonResponse(200, {
        access_token: 'access-v2', token_type: 'Bearer', expires_in: 900,
        refresh_token: 'refresh-v2', refresh_expires_at: 4_100_000_000_000,
        scope: 'personal', user_id: 'member-1', org_id: 'organization-1', node_id: 'node-1',
      });
    }) as unknown as typeof fetch;

    const refresher = createCredentialRefresher({ serverUrl: 'https://sync.example.com', credentialPath, fetchImpl });

    // Nothing was transmitted, so the refresh token is untouched. This is the
    // one network failure that is genuinely a retry -- exit 3 means "this
    // credential is gone", not "the server was not answering".
    const error = await refresher.getAccessToken().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(CredentialRevokedError);

    // And the marker is cleared, because nothing was sent: leaving it would
    // make the next start refuse to run over an outage that touched nothing.
    expect(readCredentialFile(credentialPath).refreshInFlightAt).toBeUndefined();

    reachable = true;
    expect(await refresher.getAccessToken()).toBe('access-v2');
  });

  it('will not retry a request that may already have reached the server', async () => {
    // A socket reset gives no evidence about whether the server processed the
    // rotation. Undici surfaces the code on `cause`.
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
      });
    }) as unknown as typeof fetch;

    const refresher = createCredentialRefresher({ serverUrl: 'https://sync.example.com', credentialPath, fetchImpl });

    await expect(refresher.getAccessToken()).rejects.toMatchObject({ reason: 'rotation_uncertain' });
    // The marker stays, and the token is never presented a second time.
    expect(readCredentialFile(credentialPath).refreshInFlightAt).toBeDefined();
    await expect(refresher.refresh()).rejects.toBeInstanceOf(CredentialRevokedError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('treats a 503 as uncertain, because the server mints the token AFTER rotating', async () => {
    // deviceAuthRoutes.ts mints the access token after committing the DO
    // rotation, so a mint failure returns 503 on a credential that is already
    // spent. "5xx means the server did nothing" is exactly the assumption that
    // turns one bad response into a destroyed credential.
    const fetchImpl = vi.fn(async () =>
      jsonResponse(503, { error: 'service_unavailable' }),
    ) as unknown as typeof fetch;

    const refresher = createCredentialRefresher({
      serverUrl: 'https://sync.example.com',
      credentialPath,
      fetchImpl,
    });

    await expect(refresher.refresh()).rejects.toMatchObject({ reason: 'rotation_uncertain' });

    // No second request, ever: that is the replay this exists to prevent. And
    // the marker stays, so a restart does not present the token either.
    await expect(refresher.getAccessToken()).rejects.toBeInstanceOf(CredentialRevokedError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(readCredentialFile(credentialPath).refreshInFlightAt).toBeDefined();
    expect(readCredentialFile(credentialPath).refreshToken).toBe('refresh-v1');
  });

  it('treats a 2xx it cannot use as uncertain rather than retrying it', async () => {
    // The server answered, so it very likely rotated. A body we cannot read is
    // not evidence that it did not.
    const refresher = createCredentialRefresher({
      serverUrl: 'https://sync.example.com',
      credentialPath,
      fetchImpl: (async () => jsonResponse(200, { unexpected: true })) as unknown as typeof fetch,
    });

    await expect(refresher.refresh()).rejects.toMatchObject({ reason: 'rotation_uncertain' });
  });

  it('does not read a 400 without a revocation code as a confirmed revocation', async () => {
    // `invalid_grant` and `expired_token` are the only answers that CONFIRM the
    // credential is gone. Anything else on a 400 is unresolved rather than
    // revoked -- still terminal, but reported as what it is.
    const refresher = createCredentialRefresher({
      serverUrl: 'https://sync.example.com',
      credentialPath,
      fetchImpl: (async () => jsonResponse(400, { error: 'invalid_request' })) as unknown as typeof fetch,
    });

    await expect(refresher.refresh()).rejects.toMatchObject({ reason: 'rotation_uncertain' });
  });

  it('rejects a credential file missing the fields the desktop must provision', () => {
    writeFileSync(credentialPath, JSON.stringify({ nodeId: 'node-1' }));
    expect(() => readCredentialFile(credentialPath)).toThrow(/missing "userId"/);
  });

  it('leaves no partial file behind when the rename target is unwritable', () => {
    const badPath = join(directory, 'missing-dir', 'node-credential.json');
    expect(() => writeCredentialFileAtomic(badPath, BASE)).toThrow();
    expect(() => readFileSync(badPath, 'utf-8')).toThrow();
  });
});
