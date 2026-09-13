/**
 * The node's half of the RFC 8628 device grant: refresh only.
 *
 * The DESKTOP performs `/code`, `/approve` and `/token` and hands this process
 * an already-issued credential file. All this module ever does is renew it.
 *
 * The refresh token ROTATES on every use, and presenting a superseded token
 * DESTROYS the credential server-side -- there is no way back except the
 * desktop re-provisioning the node. The dangerous window is not the write, it
 * is the gap between the server rotating and us learning that it did: a crash
 * or a lost response there leaves the OLD token on disk, and the next start
 * replays it into a permanent revocation.
 *
 * So a rotation is a three-phase durable transaction:
 *
 *  1. Write a `refreshInFlightAt` marker to the credential file and fsync it
 *     (and its directory) BEFORE the request goes out. Surviving this marker is
 *     what tells the next process "the token beside me may already be spent".
 *  2. On the response, write the new credential durably and fsync again.
 *  3. Only then clear the marker, cache the access token, and let a caller use
 *     it. An access token that is not on disk is never handed out -- otherwise
 *     the process runs on a credential no restart can reproduce.
 *
 * A marker found ON DISK at startup is terminal. Phase 2 writes the replacement
 * WITHOUT the marker, so a marker that survived means phase 2 never completed --
 * the token beside it may be spent, and this process cannot know, because it is
 * not the process that sent the request. Replaying it there is the one move that
 * can destroy a credential that is still alive, so it is never made: exit 3 and
 * let the desktop re-provision. A crash that happened to beat the server pays
 * the same price, and that is the trade we want -- a re-provision is a defined
 * recovery, a destroyed credential is not.
 *
 * Within one process a refresh has three outcomes, and the dividing line is
 * whether the request was SENT -- not what the status code says:
 *
 *  - **transient**: the request provably never left this machine (DNS failure,
 *    connection refused, connect timeout). The token is untouched, so this is
 *    the one case that retries, with backoff, and the marker is cleared.
 *  - **uncertain**: anything else once the request has gone out. A 5xx is in
 *    here, and that is the whole point: the server mints the access token
 *    AFTER committing the rotation, so a mint failure returns 503 on a
 *    credential it has already spent. A lost response and a malformed 2xx are
 *    the same shape. So is a replacement we could not persist. All terminal:
 *    the token is never presented again, and the desktop re-provisions.
 *  - **revoked**: HTTP 400 with `invalid_grant` or `expired_token`, and nothing
 *    else. Terminal, and the only answer that CONFIRMS the credential is gone.
 *
 * Only the first retries. The asymmetry is deliberate: a needless re-provision
 * costs the user one dialog, and a replayed refresh token destroys a credential
 * that was still alive.
 */

import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import * as path from 'node:path';
import { decodeNodeAccessTokenClaims } from '@nimbalyst/runtime/sync/nodeCredentialToken';

/**
 * `node-credential.json` on disk. Written by the desktop at provisioning time
 * and rewritten by this process on every refresh; the key names are a contract
 * with the desktop and must not be renamed.
 */
export interface NodeCredential {
  nodeId: string;
  userId: string;
  orgId: string;
  refreshToken: string;
  /** Epoch ms the refresh token itself expires. Past this the desktop must re-provision. */
  refreshExpiresAt: number;
  accessToken?: string;
  /** Epoch ms the access token expires. The server closes sockets with 4003 past it. */
  accessTokenExpiresAt?: number;
  /**
   * Epoch ms a rotation was started and not yet known to have finished.
   *
   * Present on disk means: the `refreshToken` beside it was handed to the
   * server and MAY already have been spent. Exactly one attempt may be made
   * with it; a 400 means the rotation did land and this credential is gone.
   */
  refreshInFlightAt?: number;
}

/**
 * The credential is gone and cannot be recovered by retrying. The process exits
 * 3 on this so the supervisor knows to ask the desktop for a new one rather
 * than restart into the same rejection.
 */
export class CredentialRevokedError extends Error {
  constructor(readonly reason: string, message: string) {
    super(message);
    this.name = 'CredentialRevokedError';
  }
}

function fail(message: string): never {
  throw new Error(`[nimbalyst-node] ${message}`);
}

export function readCredentialFile(credentialPath: string): NodeCredential {
  let raw: string;
  try {
    raw = readFileSync(credentialPath, 'utf-8');
  } catch (error) {
    fail(
      `could not read the node credential at ${credentialPath}. `
      + `The desktop provisions this file; it is never derived from the environment: `
      + `${(error as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(`node credential ${credentialPath} is not valid JSON: ${(error as Error).message}`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    fail(`node credential ${credentialPath} must contain a JSON object`);
  }

  const credential = parsed as Partial<NodeCredential>;
  for (const key of ['nodeId', 'userId', 'orgId', 'refreshToken'] as const) {
    if (typeof credential[key] !== 'string' || credential[key]!.length === 0) {
      fail(`node credential ${credentialPath} is missing "${key}"`);
    }
  }

  return {
    nodeId: credential.nodeId!,
    userId: credential.userId!,
    orgId: credential.orgId!,
    refreshToken: credential.refreshToken!,
    refreshExpiresAt: Number(credential.refreshExpiresAt ?? 0),
    accessToken: credential.accessToken,
    accessTokenExpiresAt: credential.accessTokenExpiresAt,
    refreshInFlightAt: typeof credential.refreshInFlightAt === 'number'
      ? credential.refreshInFlightAt
      : undefined,
  };
}

/**
 * fsync the directory, so the rename itself is durable.
 *
 * Renaming over a file makes the REPLACEMENT atomic, not durable: after a power
 * loss the directory entry can still point at the old inode. Without this the
 * whole three-phase transaction above is decoration.
 */
function fsyncDirectory(directory: string): void {
  let handle: number | undefined;
  try {
    handle = openSync(directory, 'r');
  } catch {
    // Not every platform permits opening a directory at all (Windows). The
    // rename is still atomic; only the durability guarantee is weaker, and
    // there is nothing here to report.
    return;
  }

  try {
    // A failure HERE is a real durability failure, and it is propagated. It was
    // previously swallowed alongside the platform case above, which meant the
    // caller was told the credential was durable when the filesystem had said
    // otherwise -- and the whole three-phase transaction is built on that answer
    // being true.
    fsyncSync(handle);
  } finally {
    try { closeSync(handle); } catch { /* nothing useful to do */ }
  }
}

/**
 * Replace the credential file atomically.
 *
 * A partially-written credential is indistinguishable from a corrupt one and
 * costs a re-provision, so the new content lands in a sibling temp file and is
 * renamed over the target -- rename is atomic within a filesystem, and the temp
 * file is a sibling precisely so it is on the same one.
 */
export function writeCredentialFileAtomic(
  credentialPath: string,
  credential: NodeCredential,
): void {
  const directory = path.dirname(credentialPath);
  const temp = path.join(directory, `.${path.basename(credentialPath)}.${process.pid}.tmp`);
  try {
    // fsync the CONTENT before the rename: a rename that beats the data to disk
    // publishes an empty or half-written credential, which costs a re-provision
    // exactly as much as losing it.
    const handle = openSync(temp, 'w', 0o600);
    try {
      writeSync(handle, `${JSON.stringify(credential, null, 2)}\n`);
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    renameSync(temp, credentialPath);
    fsyncDirectory(directory);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // The temp file may not exist; the original error is the one that matters.
    }
    throw error;
  }
}

/**
 * Errors that prove the request never left this machine.
 *
 * The list is deliberately short and deliberately an allowlist: every code here
 * is raised while resolving or opening the connection, before a byte of the
 * request is written. Anything else -- a reset, a timeout, an aborted body, an
 * unrecognised code -- may have occurred AFTER the server received and acted on
 * the rotation, and a rotation whose outcome we cannot establish is never
 * retried. Guessing in the other direction destroys the credential.
 *
 * `fetch` wraps the cause, so both levels are checked.
 */
const PRE_SEND_NETWORK_CODES = new Set([
  'ENOTFOUND',        // DNS: no such host
  'EAI_AGAIN',        // DNS: temporary resolution failure
  'ECONNREFUSED',     // nothing listening
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EADDRNOTAVAIL',
  'UND_ERR_CONNECT_TIMEOUT', // undici: the connection was never established
]);

export function isPreSendNetworkError(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 4; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && PRE_SEND_NETWORK_CODES.has(code)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** Shape of a successful `POST /auth/device/refresh`. */
interface DeviceRefreshResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  refresh_expires_at: number;
  scope: string;
  user_id: string;
  org_id: string;
  node_id: string;
}

export interface CredentialRefresherOptions {
  serverUrl: string;
  credentialPath: string;
  /** Injected in tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injected in tests. */
  now?: () => number;
  /** Injected in tests; defaults to the atomic file write. */
  writeCredential?: (credentialPath: string, credential: NodeCredential) => void;
  /** Injected in tests; defaults to reading the file. */
  readCredential?: (credentialPath: string) => NodeCredential;
  log?: (event: string, fields?: Record<string, unknown>) => void;
  /**
   * Refresh this far before the access token actually expires. The server
   * closes a node socket with 4003 the moment it expires, so the margin has to
   * cover a reconnect, not just the round trip.
   */
  refreshSkewMs?: number;
}

export interface CredentialRefresher {
  /** A valid access token, refreshing first when the cached one is near expiry. */
  getAccessToken(): Promise<string>;
  /** Force a rotation regardless of the cached token's remaining life. */
  refresh(): Promise<string>;
  /** Epoch ms the cached access token expires, or undefined when none is cached. */
  accessTokenExpiresAt(): number | undefined;
  /** The current credential, for logging identity (never the tokens). */
  nodeId(): string;
}

const DEFAULT_REFRESH_SKEW_MS = 3 * 60 * 1000;

/**
 * When the access token actually expires, in epoch ms.
 *
 * The token's own `exp` is authoritative and `expires_in` is not: `exp` was
 * minted against the SERVER's clock, and `now() + expires_in` is measured
 * against ours. CollabV3Sync's `ensureFreshJwt` rejects a token whose `exp` has
 * passed -- so on a container whose clock runs slow, a token we still believe
 * is valid is refused locally, and the provider reconnect-loops on a credential
 * that looks fine from here. Claims are UNIX SECONDS.
 *
 * Falls back to `expires_in` only when the token cannot be decoded, which for a
 * real server response means the lane changed shape and the fallback is the
 * conservative answer rather than a crash.
 */
function accessTokenExpiryMs(
  accessToken: string,
  expiresInSeconds: number,
  now: () => number,
): number {
  try {
    return decodeNodeAccessTokenClaims(accessToken).exp * 1000;
  } catch {
    return now() + expiresInSeconds * 1000;
  }
}

export function createCredentialRefresher(
  options: CredentialRefresherOptions,
): CredentialRefresher {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const writeCredential = options.writeCredential ?? writeCredentialFileAtomic;
  const readCredential = options.readCredential ?? readCredentialFile;
  const log = options.log ?? (() => {});
  const skewMs = options.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;

  let credential: NodeCredential | null = null;
  let inFlight: Promise<string> | null = null;
  /**
   * A marker was on disk when this process first read the credential.
   *
   * Phase 2 writes the replacement WITHOUT the marker, so this means phase 2
   * never completed and the token beside it may already be spent. This process
   * did not send that request and cannot find out how it ended, so the
   * credential is treated as unrecoverable -- see the header.
   */
  let markerFoundOnDisk = false;
  /**
   * Set once the credential is known to be unrecoverable.
   *
   * Terminal is terminal from every entry point: without this, a caller that
   * asks a second way (`getAccessToken` after `refresh`) gets whatever error the
   * next attempt happens to produce, and a transient-looking message sends the
   * supervisor back into a retry loop on a credential that can never work.
   */
  let terminal: CredentialRevokedError | null = null;
  /**
   * Whether `credential.accessToken` is known to be on disk.
   *
   * A token that only exists in this process's heap must never be handed out:
   * the rotation that produced it already spent the refresh token, so if we
   * run on it and then die, nothing can reproduce it.
   */
  let accessTokenPersisted = false;

  function loaded(): NodeCredential {
    if (!credential) {
      const fromDisk = readCredential(options.credentialPath);
      markerFoundOnDisk = fromDisk.refreshInFlightAt !== undefined;
      // Re-derive the expiry from the token rather than trusting the number
      // beside it: that number was written by whoever last wrote the file
      // (possibly the desktop, possibly a process on a different clock), while
      // the token carries the server's own answer. An undecodable token yields
      // `now`, i.e. "expired", which forces a refresh -- the safe direction.
      credential = fromDisk.accessToken
        ? { ...fromDisk, accessTokenExpiresAt: accessTokenExpiryMs(fromDisk.accessToken, 0, now) }
        : fromDisk;
      // It came off disk, so by definition it is persisted.
      accessTokenPersisted = fromDisk.accessToken !== undefined;
    }
    return credential;
  }

  /** Record a terminal outcome once, so every later call reports the same thing. */
  function revoke(reason: string, message: string): never {
    terminal ??= new CredentialRevokedError(reason, message);
    throw terminal;
  }

  async function performRefresh(): Promise<string> {
    if (terminal) throw terminal;
    const current = loaded();
    const url = `${options.serverUrl.replace(/\/+$/, '')}/auth/device/refresh`;

    if (markerFoundOnDisk) {
      // Terminal, and deliberately WITHOUT sending anything. A previous process
      // presented this token and never got as far as writing a replacement, so
      // the server may already have rotated it. Presenting it again is the one
      // move that can destroy a credential which is still alive; a re-provision
      // is a defined recovery, so we take that instead of guessing.
      log('credential-rotation-unresolved', {
        credentialPath: options.credentialPath,
        startedAt: current.refreshInFlightAt,
        note: 'a rotation was in flight when the previous process stopped; not replayed',
      });
      revoke(
        'rotation_unresolved',
        '[nimbalyst-node] a credential rotation was interrupted and cannot be resumed safely. '
        + 'The desktop must re-provision this node.',
      );
    }

    // Phase 1: record that this token is about to be presented, durably, BEFORE
    // it goes out. If we die past this point the next process knows the token
    // beside the marker may already be spent, instead of cheerfully replaying it.
    // A failure here is safe to retry: nothing has been sent.
    writeCredential(options.credentialPath, { ...current, refreshInFlightAt: now() });

    /**
     * The request provably never left this machine, so the token is untouched.
     *
     * Clearing the marker here is what keeps a server outage from poisoning the
     * next start, and it is only safe because nothing was sent.
     */
    function clearMarkerAfterUnsentRequest(): void {
      try {
        writeCredential(options.credentialPath, { ...current, refreshInFlightAt: undefined });
      } catch (error) {
        log('credential-marker-clear-failed', {
          credentialPath: options.credentialPath,
          error: (error as Error).message,
          consequence: 'a restart before the next successful rotation will refuse to run',
        });
      }
    }

    /** Terminal: the rotation may have happened and we cannot tell. */
    function uncertain(detail: string): never {
      revoke(
        'rotation_uncertain',
        `[nimbalyst-node] the credential rotation could not be resolved (${detail}). `
        + 'The refresh token may already be spent, so it will not be presented again. '
        + 'The desktop must re-provision this node.',
      );
    }

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refresh_token: current.refreshToken }),
      });
    } catch (error) {
      if (!isPreSendNetworkError(error)) {
        // The request may have reached the server and rotated the credential;
        // the response is simply gone. Retrying would present a token that may
        // already be spent, and the server destroys the credential on replay.
        uncertain(`the request failed after it may have been sent: ${(error as Error).message}`);
      }
      // DNS or connect failure: nothing was transmitted, so this is the one
      // network failure that is genuinely a retry.
      clearMarkerAfterUnsentRequest();
      throw error;
    }

    if (response.status === 400) {
      let reason: string | undefined;
      try {
        const body = (await response.json()) as { error?: string };
        if (typeof body?.error === 'string') reason = body.error;
      } catch {
        // An unreadable body cannot confirm anything.
      }

      if (reason === 'invalid_grant' || reason === 'expired_token') {
        // The only answer that CONFIRMS the credential is gone. Retrying risks
        // destroying a replacement issued in the meantime.
        revoke(
          reason,
          `[nimbalyst-node] node credential rejected (${reason}). `
          + 'The desktop must re-provision this node.',
        );
      }

      uncertain(`HTTP 400 without a revocation code (${reason ?? 'no error code'})`);
    }

    if (!response.ok) {
      // A 5xx does NOT prove the server did not rotate: it mints the access
      // token AFTER committing the rotation, so a mint failure returns 503 on a
      // credential that is already spent. Retrying there is exactly the replay
      // that destroys it.
      uncertain(`HTTP ${response.status} from ${url}`);
    }

    let body: DeviceRefreshResponse;
    try {
      body = (await response.json()) as DeviceRefreshResponse;
    } catch (error) {
      uncertain(`the 2xx body could not be read: ${(error as Error).message}`);
    }
    if (typeof body?.access_token !== 'string' || typeof body?.refresh_token !== 'string') {
      // A 2xx we cannot use. The server answered, so it very likely rotated.
      uncertain('the 2xx response carried no usable tokens');
    }

    const next: NodeCredential = {
      nodeId: body.node_id ?? current.nodeId,
      userId: body.user_id ?? current.userId,
      orgId: body.org_id ?? current.orgId,
      refreshToken: body.refresh_token,
      refreshExpiresAt: Number(body.refresh_expires_at ?? current.refreshExpiresAt),
      accessToken: body.access_token,
      accessTokenExpiresAt: accessTokenExpiryMs(
        body.access_token,
        Number(body.expires_in ?? 0),
        now,
      ),
      // Phase 3, implicitly: the marker is absent from what we write, so a
      // successful write is what clears it.
      refreshInFlightAt: undefined,
    };

    try {
      // Phase 2. Until this returns, the caller may not treat the refresh as
      // complete and may not use the access token.
      writeCredential(options.credentialPath, next);
      credential = next;
      accessTokenPersisted = true;
    } catch (error) {
      // The UNCERTAIN outcome, and it is terminal.
      //
      // The server has rotated. The replacement exists only in this process's
      // heap, and the token on disk is spent. Retrying is not a retry: whatever
      // this process does next, a restart reads a credential that the server
      // will reject, so the node is already unrecoverable without the desktop.
      // Saying so now -- rather than looping on a token that cannot work -- is
      // the difference between one re-provision and a node that looks alive and
      // silently is not.
      credential = { ...next, refreshInFlightAt: current.refreshInFlightAt ?? now() };
      accessTokenPersisted = false;
      log('credential-persist-failed', {
        credentialPath: options.credentialPath,
        error: (error as Error).message,
        consequence: 'the rotated credential could not be stored; this node must be re-provisioned',
      });
      revoke(
        'rotation_unpersisted',
        '[nimbalyst-node] the rotated credential could not be written to '
        + `${options.credentialPath} (${(error as Error).message}). `
        + 'The token on disk is spent. The desktop must re-provision this node.',
      );
    }

    log('credential-refreshed', {
      nodeId: next.nodeId,
      expiresInMs: (next.accessTokenExpiresAt ?? 0) - now(),
    });
    return next.accessToken!;
  }

  async function refresh(): Promise<string> {
    // Coalesce: the proactive timer and a reconnect can both ask at once, and a
    // second concurrent refresh would present the token the first just retired.
    if (inFlight) return inFlight;
    inFlight = performRefresh().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  return {
    async getAccessToken(): Promise<string> {
      if (terminal) throw terminal;
      const current = loaded();
      if (
        accessTokenPersisted
        && current.refreshInFlightAt === undefined
        && current.accessToken
        && current.accessTokenExpiresAt !== undefined
        && current.accessTokenExpiresAt - now() > skewMs
      ) {
        return current.accessToken;
      }
      // A marker found on disk lands here too, and `performRefresh` rejects it
      // as unresolvable on the FIRST call -- before a socket is opened -- rather
      // than letting the node come up on a cached token and discover fifteen
      // minutes later, mid-turn, that it cannot rotate.
      return refresh();
    },
    refresh,
    accessTokenExpiresAt: () => credential?.accessTokenExpiresAt,
    nodeId: () => loaded().nodeId,
  };
}
