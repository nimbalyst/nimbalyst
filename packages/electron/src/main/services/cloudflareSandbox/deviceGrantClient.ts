/**
 * The OAuth device-authorization grant that gives the sandbox node its own
 * credential on the sync server.
 *
 * Normally a device grant shows the user a code to type on another screen. Here
 * the desktop is both the device being authorized and the human approving it,
 * so it runs code -> approve -> token back to back and no user code is ever
 * displayed. That is only legitimate because the approval is authorized with
 * *this user's* personal Stytch JWT: the sandbox never sees it, and the
 * credential the grant returns is scoped to the node, not to the desktop.
 *
 * The JWT is typed `PersonalJwt`, so handing this a team JWT is a compile
 * error. It has to be: `/auth/device/approve` answers a team JWT with 403
 * `personal_scope_required`, and a member has a different id per org, so a team
 * identity would bind the node to the wrong subject. See
 * docs/IDENTITY_AUTH_AND_ROOMS.md and packages/runtime/src/auth/jwtScopes.ts.
 *
 * Two things this module refuses to do:
 *
 *  - **Log anything.** Every field it handles — the device code, the access
 *    token, the refresh token, the JWT — is replayable material, and `main.log`
 *    outlives the failure it would have been logged for.
 *  - **Repeat what the server said.** Error labels come from a fixed allowlist,
 *    never from response text. `toSandboxError` writes the label to the log, so
 *    interpolating `body.error` would let anything on the other end of the
 *    socket choose what lands on the user's disk.
 */

import { asPersonalMemberId, type PersonalJwt, type PersonalMemberId } from "@nimbalyst/runtime/auth/jwtScopes";

import { SandboxOperationError } from "./errors";

/** What the node needs on disk to join sync as itself. */
export interface NodeCredential {
  nodeId: string;
  userId: PersonalMemberId;
  orgId: string;
  refreshToken: string;
  /** Epoch milliseconds, from the server. */
  refreshExpiresAt: number;
  accessToken: string;
  /** Epoch milliseconds, derived from the server's `expires_in`. */
  accessTokenExpiresAt: number;
}

export interface DeviceGrantDeps {
  /** e.g. `https://sync.nimbalyst.com`. No trailing slash required. */
  serverUrl: string;
  /**
   * The PERSONAL Stytch JWT, and only that. Read lazily so a long poll cannot
   * be authorized with a JWT that expired while it waited.
   */
  personalJwt: () => PersonalJwt | null;
  fetch: typeof globalThis.fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The only error identifiers this client will repeat.
 *
 * Anything else — including a plausible-looking string the server has never
 * sent before — becomes `rejected`. The set is small on purpose: it is an
 * allowlist of values this codebase has read in `deviceAuthRoutes.ts`, not a
 * filter over untrusted text.
 */
const KNOWN_GRANT_ERRORS = new Set([
  "authorization_pending",
  "slow_down",
  "expired_token",
  "access_denied",
  "invalid_grant",
  "unsupported_grant_type",
  "personal_scope_required",
  "rate_limited",
  "unauthorized",
  "unknown_node",
]);

/** Server default; only used when the response omits `interval`. */
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
/** RFC 8628 section 3.5: each `slow_down` adds five seconds to the interval. */
const SLOW_DOWN_INCREMENT_MS = 5_000;
/** Bound on the whole grant, independent of what the server says. */
const MAX_GRANT_MS = 10 * 60_000;
/** Covers the response body too, not just the headers. See `#request`. */
const REQUEST_TIMEOUT_MS = 20_000;

interface GrantResponse {
  ok: boolean;
  body: Record<string, unknown>;
}

type TokenPoll =
  | { credential: NodeCredential }
  | { credential: null; slowDown: boolean };

export class DeviceGrantClient {
  #serverUrl: string;
  #personalJwt: () => PersonalJwt | null;
  #fetch: typeof globalThis.fetch;
  #now: () => number;
  #sleep: (ms: number) => Promise<void>;

  constructor(deps: DeviceGrantDeps) {
    this.#serverUrl = deps.serverUrl.replace(/\/+$/, "");
    this.#personalJwt = deps.personalJwt;
    this.#fetch = deps.fetch;
    this.#now = deps.now ?? (() => Date.now());
    this.#sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /**
   * Run the whole grant and return the node's credential.
   *
   * The first token poll happens immediately after the approval rather than
   * after one interval: the grant is already approved at that point, so waiting
   * out a polling interval would only add latency. Subsequent polls respect the
   * server's interval, which is what its per-IP rate limit is sized for.
   */
  async run(deviceLabel: string): Promise<NodeCredential> {
    const deadline = this.#now() + MAX_GRANT_MS;

    const code = await this.#expectOk(
      "/auth/device/code",
      { client_id: "nimbalyst-node", device_label: deviceLabel },
      "grant-code",
      false,
    );

    const deviceCode = typeof code.device_code === "string" ? code.device_code : "";
    const userCode = typeof code.user_code === "string" ? code.user_code : "";
    if (!deviceCode || !userCode) {
      throw new SandboxOperationError("grant-failed", "grant-code-shape");
    }
    let intervalMs =
      (typeof code.interval === "number" && code.interval > 0
        ? code.interval
        : DEFAULT_POLL_INTERVAL_SECONDS) * 1000;

    const approval = await this.#expectOk(
      "/auth/device/approve",
      { user_code: userCode, action: "approve" },
      "grant-approve",
      true,
    );
    if (approval.status !== "approved") {
      throw new SandboxOperationError("grant-failed", "grant-not-approved");
    }

    for (;;) {
      const poll = await this.#postToken(deviceCode);
      if (poll.credential) return poll.credential;
      // Backing off on `slow_down` is the difference between recovering from a
      // rate limit and sitting in one until the grant expires.
      if (poll.slowDown) intervalMs += SLOW_DOWN_INCREMENT_MS;
      if (this.#now() + intervalMs > deadline) {
        throw new SandboxOperationError("grant-failed", "grant-poll-timeout");
      }
      await this.#sleep(intervalMs);
    }
  }

  /**
   * Invalidate a node credential. Idempotent.
   *
   * Called before issuing a new one, so a re-provision does not leave the
   * previous node able to keep joining the user's personal rooms from a
   * container they believe they replaced.
   *
   * A credential that is already gone answers `404 unknown_node`, and that has
   * to count as success. Revocation gates replacement, so treating "already
   * revoked" as a failure would wedge the sandbox permanently: every retry
   * would re-revoke the same dead id, get the same 404, and refuse to issue.
   * The desired state is "this credential cannot be used", and a 404 means the
   * desired state holds.
   */
  async revoke(nodeId: string): Promise<void> {
    if (!nodeId) return;
    const { ok, body } = await this.#request(
      "/auth/device/revoke",
      { node_id: nodeId },
      "grant-revoke",
      true,
    );
    if (ok) return;
    const label = errorLabel(body.error);
    if (label === "unknown_node") return;
    throw new SandboxOperationError("grant-failed", `grant-revoke-${label}`);
  }

  async #postToken(deviceCode: string): Promise<TokenPoll> {
    const { ok, body } = await this.#request(
      "/auth/device/token",
      {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
      },
      "grant-token",
      false,
    );

    if (!ok) {
      // RFC 8628: the pending and back-off states are reported as 400s. Only
      // those two are retryable; anything else means the grant is dead and
      // polling it again would just burn the rate limit.
      const label = errorLabel(body.error);
      if (label === "authorization_pending") return { credential: null, slowDown: false };
      if (label === "slow_down") return { credential: null, slowDown: true };
      throw new SandboxOperationError("grant-failed", `grant-token-${label}`);
    }

    const accessToken = typeof body.access_token === "string" ? body.access_token : "";
    const refreshToken = typeof body.refresh_token === "string" ? body.refresh_token : "";
    const nodeId = stringField(body.node_id);
    const userId = stringField(body.user_id);
    const orgId = stringField(body.org_id);
    const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 0;
    const refreshExpiresAt =
      typeof body.refresh_expires_at === "number" ? body.refresh_expires_at : 0;

    if (!accessToken || !refreshToken || !nodeId || !userId || !orgId || expiresIn <= 0) {
      throw new SandboxOperationError("grant-failed", "grant-token-shape");
    }

    return {
      credential: {
        nodeId,
        // The device grant was approved with the personal-org JWT above.
        userId: asPersonalMemberId(userId),
        orgId,
        refreshToken,
        refreshExpiresAt,
        accessToken,
        accessTokenExpiresAt: this.#now() + expiresIn * 1000,
      },
    };
  }

  async #expectOk(
    path: string,
    payload: Record<string, unknown>,
    event: string,
    authorized: boolean,
  ): Promise<Record<string, unknown>> {
    const { ok, body } = await this.#request(path, payload, event, authorized);
    if (!ok) {
      throw new SandboxOperationError("grant-failed", `${event}-${errorLabel(body.error)}`);
    }
    return body;
  }

  /**
   * One request, one timeout, covering the body read.
   *
   * The abort signal deliberately stays armed through `response.json()`. A
   * timeout that ends at the response headers leaves a server that sends them
   * and then stalls able to hang this promise forever — and because connect
   * runs on the service's serial mutation queue, that would wedge every later
   * sandbox operation, not just this one.
   */
  async #request(
    path: string,
    payload: Record<string, unknown>,
    event: string,
    authorized: boolean,
  ): Promise<GrantResponse> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (authorized) {
      const jwt = this.#personalJwt();
      // A missing personal JWT is a sign-in problem, not a grant problem, and
      // saying "authorization failed" would send the user to the wrong fix.
      if (!jwt) throw new SandboxOperationError("not-authenticated", `${event}-no-personal-jwt`);
      headers.authorization = `Bearer ${jwt}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      let response: Response;
      try {
        response = await this.#fetch(`${this.#serverUrl}${path}`, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } catch {
        // The transport error is dropped rather than wrapped: fetch failures
        // can echo the request URL and, on some runtimes, request headers.
        throw new SandboxOperationError("grant-failed", `${event}-unreachable`);
      }

      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch {
        throw new SandboxOperationError("grant-failed", `${event}-body`);
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new SandboxOperationError("grant-failed", `${event}-body`);
      }

      return { ok: response.ok, body: parsed as Record<string, unknown> };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Reduce a server-supplied `error` field to a label this codebase authored.
 *
 * This is the whole defence for finding 4: the label is interpolated into an
 * event that `sandboxError` writes to `main.log`, so anything not on the
 * allowlist has to be discarded rather than repeated.
 */
function errorLabel(raw: unknown): string {
  return typeof raw === "string" && KNOWN_GRANT_ERRORS.has(raw) ? raw : "rejected";
}

/** `user_id` and friends are ids, but the server has typed them loosely. */
function stringField(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}
