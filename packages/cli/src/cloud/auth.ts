/**
 * `nim login` (device flow against our authorization server), transparent
 * refresh, and the bearer fetch every wiki call goes through.
 *
 * The user approves the device code on the console with their Nimbalyst Teams
 * sign-in; the CLI only ever holds the server's access and refresh tokens. The
 * earlier GitHub device flow plus `/oauth/github/exchange` is kept behind
 * `NIM_GITHUB_NATIVE=on`.
 */
import { CliError, ExitCode, connectionError } from '../cli/exitCodes.js';
import { NIM_CLI_CLIENT_ID, resolveGithubClientId } from './config.js';
import { loadCredentials, saveCredentials, withCredentialsLock, type StoredCredentials } from './credentials.js';

const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_SCOPES = 'read:user user:email';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
/**
 * Every token call finishes well inside the credentials lock's 30s stale
 * window, so a slow refresh cannot outlive its lock and race a takeover.
 */
const TOKEN_CALL_TIMEOUT_MS = 20_000;

export const notLoggedInError = () =>
  new CliError(ExitCode.USAGE, "Not logged in. Run 'nim login' first.");

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

async function postJson(url: string, body: unknown, form = false): Promise<{ status: number; json: any }> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json',
      },
      body: form ? new URLSearchParams(body as Record<string, string>).toString() : JSON.stringify(body),
      signal: AbortSignal.timeout(TOKEN_CALL_TIMEOUT_MS),
    });
  } catch (err: any) {
    throw connectionError(`Could not reach ${new URL(url).origin}: ${err?.message ?? err}`);
  }
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Device-flow timing from the server is clamped: a junk or hostile value must neither busy-loop nor hang. */
const DEVICE_INTERVAL_MAX_S = 60;
const DEVICE_INTERVAL_DEFAULT_S = 5;
const DEVICE_EXPIRES_MAX_S = 1800;
const DEVICE_EXPIRES_DEFAULT_S = 900;

/** Shortest poll interval; `NIM_DEVICE_POLL_FLOOR_MS` lowers it (tests). */
function pollFloorMs(): number {
  const n = Number(process.env.NIM_DEVICE_POLL_FLOOR_MS);
  return Number.isFinite(n) && n >= 0 ? n : 1000;
}

export function boundedIntervalMs(seconds: unknown, fallbackS: number): number {
  const s = Number(seconds);
  const ms = (Number.isFinite(s) && s >= 0 ? Math.min(s, DEVICE_INTERVAL_MAX_S) : fallbackS) * 1000;
  return Math.max(ms, pollFloorMs());
}

export function boundedExpiresMs(seconds: unknown): number {
  const s = Number(seconds);
  return (Number.isFinite(s) && s > 0 ? Math.min(s, DEVICE_EXPIRES_MAX_S) : DEVICE_EXPIRES_DEFAULT_S) * 1000;
}

interface DeviceFlow {
  /** Who is asking the user to approve, for messages ("Nimbalyst", "GitHub"). */
  label: string;
  codeUrl: string;
  tokenUrl: string;
  clientId: string;
  scope?: string;
}

/**
 * A device code that was shown to the user and is still being approved. It is
 * enough to resume polling from another process: a host that restarts the MCP
 * server between tool calls must finish the code the user approved, not mint a
 * new one.
 */
export interface PendingDeviceLogin {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  intervalMs: number;
  /** Epoch ms after which the code is expired. */
  deadline: number;
}

export interface DeviceLoginOptions {
  /** Poll this code instead of requesting a new one. The prompt is repeated with its code. */
  resume?: PendingDeviceLogin;
  /** Called once a new code exists, before polling, so a caller can keep it. */
  onStarted?: (pending: PendingDeviceLogin) => void;
}

/** RFC 8628: request a code, show it, poll until approved. Returns the token response. */
async function runDeviceFlow(
  flow: DeviceFlow,
  onPrompt: (userCode: string, verificationUri: string, verificationUriComplete?: string) => void,
  options: DeviceLoginOptions = {},
): Promise<TokenResponse> {
  let pending = options.resume;
  if (!pending) {
    const start = await postJson(flow.codeUrl, { client_id: flow.clientId, ...(flow.scope ? { scope: flow.scope } : {}) }, true);
    const { device_code, user_code, verification_uri, verification_uri_complete, expires_in } = start.json ?? {};
    if (start.status !== 200 || !device_code) {
      throw connectionError(`${flow.label} refused the device code request: ${start.json?.error_description ?? start.json?.error ?? start.status}`);
    }
    pending = {
      deviceCode: String(device_code),
      userCode: String(user_code),
      verificationUri: String(verification_uri),
      ...(typeof verification_uri_complete === 'string' ? { verificationUriComplete: verification_uri_complete } : {}),
      intervalMs: boundedIntervalMs(start.json.interval, DEVICE_INTERVAL_DEFAULT_S),
      deadline: Date.now() + boundedExpiresMs(expires_in),
    };
    options.onStarted?.(pending);
  }
  onPrompt(pending.userCode, pending.verificationUri, pending.verificationUriComplete);

  const expired = () => new CliError(ExitCode.USAGE, `The ${flow.label} sign-in code expired before it was approved. Run nim login again.`);
  const device_code = pending.deviceCode;
  let intervalMs = Math.max(pending.intervalMs, pollFloorMs());
  const deadline = pending.deadline;
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const poll = await postJson(flow.tokenUrl, { grant_type: DEVICE_GRANT, device_code, client_id: flow.clientId }, true);
    const body = poll.json as TokenResponse & { interval?: number };
    if (body.access_token) return body;
    switch (body.error) {
      case 'authorization_pending':
        continue;
      case 'slow_down':
        // RFC 8628 3.5: add 5 seconds unless the server names a new interval.
        intervalMs = boundedIntervalMs(body.interval ?? intervalMs / 1000 + 5, Math.min(intervalMs / 1000 + 5, DEVICE_INTERVAL_MAX_S));
        continue;
      case 'expired_token':
      case 'invalid_grant': // our server's answer for a spent or unknown device code
        throw expired();
      case 'access_denied':
        throw new CliError(ExitCode.USAGE, `${flow.label} sign-in was cancelled.`);
      default:
        throw connectionError(`${flow.label} sign-in failed: ${body.error_description ?? body.error ?? poll.status}`);
    }
  }
  throw expired();
}

/** `nim login`: the device flow against our own authorization server; stores the tokens. */
export async function nimbalystDeviceLogin(
  server: string,
  onPrompt: (userCode: string, verificationUri: string, verificationUriComplete?: string) => void,
  options: DeviceLoginOptions = {},
): Promise<StoredCredentials> {
  const body = await runDeviceFlow(
    { label: 'Nimbalyst', codeUrl: `${server}/oauth/device/code`, tokenUrl: `${server}/oauth/token`, clientId: NIM_CLI_CLIENT_ID },
    onPrompt,
    options,
  );
  const creds = toStored(body);
  await saveCredentials(server, creds);
  return creds;
}

/** GitHub-native mode only: runs GitHub's device flow and returns the GitHub access token. */
export async function githubDeviceFlow(onPrompt: (userCode: string, verificationUri: string) => void): Promise<string> {
  const body = await runDeviceFlow(
    { label: 'GitHub', codeUrl: GITHUB_DEVICE_CODE_URL, tokenUrl: GITHUB_TOKEN_URL, clientId: resolveGithubClientId(), scope: GITHUB_SCOPES },
    onPrompt,
  );
  return body.access_token!;
}

function toStored(body: TokenResponse): StoredCredentials {
  return {
    accessToken: body.access_token!,
    // Refresh tokens rotate on every use and a spent one revokes the family, so
    // never carry a previous one forward.
    refreshToken: body.refresh_token,
    expiresAt: body.expires_in ? Date.now() + body.expires_in * 1000 : undefined,
  };
}

/** GitHub-native mode only: trades a GitHub token for our tokens and stores them. */
export async function exchangeGithubToken(server: string, githubToken: string): Promise<StoredCredentials> {
  // Body shape per the server's githubExchange route; it mints for `nim-cli` itself.
  const res = await postJson(`${server}/oauth/github/exchange`, { github_token: githubToken });
  const body = res.json as TokenResponse;
  if (res.status !== 200 || !body.access_token) {
    throw connectionError(`${server} refused the GitHub sign-in: ${body.error_description ?? body.error ?? `HTTP ${res.status}`}`);
  }
  const creds = toStored(body);
  await saveCredentials(server, creds);
  return creds;
}

/**
 * Replaces `staleAccessToken` with a fresh one; returns undefined when refresh
 * is impossible. Runs under the credentials lock and re-reads storage first: if
 * another process already rotated the tokens, those are used and no refresh is
 * sent. A token the server rejects as `invalid_grant` is dropped, because
 * resending a spent token would revoke the whole family. Any other failure (5xx,
 * network, timeout) throws and keeps it: the token may still be good.
 */
export function refreshCredentials(server: string, staleAccessToken: string): Promise<StoredCredentials | undefined> {
  return withCredentialsLock(async () => {
    const current = loadCredentials(server);
    if (!current) return undefined;
    if (current.accessToken !== staleAccessToken) return current;
    if (!current.refreshToken) return undefined;
    const res = await postJson(
      `${server}/oauth/token`,
      { grant_type: 'refresh_token', refresh_token: current.refreshToken, client_id: NIM_CLI_CLIENT_ID },
      true,
    );
    const body = res.json as TokenResponse;
    if ((res.status === 400 || res.status === 401) && body.error === 'invalid_grant') {
      await saveCredentials(server, { ...current, refreshToken: undefined });
      return undefined;
    }
    if (res.status !== 200 || !body.access_token) {
      throw connectionError(`${server} could not refresh your session: ${body.error_description ?? body.error ?? `HTTP ${res.status}`}`);
    }
    const next = toStored(body);
    await saveCredentials(server, next);
    return next;
  });
}

/**
 * fetch with our bearer. Refreshes ahead of a known expiry, and once more on a
 * 401, then gives up with a login prompt.
 */
export async function authedFetch(server: string, pathAndQuery: string, init: RequestInit = {}): Promise<Response> {
  let creds = loadCredentials(server);
  if (!creds) throw notLoggedInError();
  let refreshed = false;
  if (creds.expiresAt && creds.expiresAt - 30_000 < Date.now()) {
    refreshed = true;
    creds = (await refreshCredentials(server, creds.accessToken)) ?? creds;
  }

  const send = (token: string) => {
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${token}`);
    if (!headers.has('accept')) headers.set('accept', 'application/json');
    return fetch(`${server}${pathAndQuery}`, { ...init, headers }).catch((err: any) => {
      throw connectionError(`Could not reach ${server}: ${err?.message ?? err}`);
    });
  };

  let res = await send(creds.accessToken);
  if (res.status !== 401) return res;
  // One refresh per command: a second attempt could only resend a spent token.
  const next = refreshed ? undefined : await refreshCredentials(server, creds.accessToken);
  if (!next) {
    throw new CliError(ExitCode.USAGE, "Your nim session has expired. Run 'nim login' again.");
  }
  res = await send(next.accessToken);
  if (res.status === 401) {
    throw new CliError(ExitCode.USAGE, "The server rejected your nim session. Run 'nim login' again.");
  }
  return res;
}

/**
 * RFC 7009 revocation of the refresh token, which also ends its access tokens'
 * family on our server. Returns a warning to print, or undefined when revoked.
 * Never throws: logout must still clear local credentials.
 */
export async function revokeRefreshToken(server: string, refreshToken: string): Promise<string | undefined> {
  try {
    const res = await postJson(
      `${server}/oauth/revoke`,
      { token: refreshToken, token_type_hint: 'refresh_token', client_id: NIM_CLI_CLIENT_ID },
      true,
    );
    if (res.status === 200) return undefined;
    return `the server did not revoke the session (${res.json?.error_description ?? res.json?.error ?? `HTTP ${res.status}`})`;
  } catch (err: any) {
    return `could not reach the server to revoke the session (${err?.message ?? err})`;
  }
}

export interface UserInfo {
  sub: string;
  email?: string;
  /** GitHub-native mode only. */
  githubUserId?: number | string;
  login?: string;
}

/** `GET /oauth/userinfo`; undefined on a server that predates it (404). */
export async function fetchUserInfo(server: string): Promise<UserInfo | undefined> {
  const res = await authedFetch(server, '/oauth/userinfo');
  if (res.status === 404) return undefined;
  const body = await res.json().catch(() => undefined);
  if (!res.ok || typeof body?.sub !== 'string') {
    throw connectionError(`${server}/oauth/userinfo returned HTTP ${res.status}.`);
  }
  return body as UserInfo;
}
