/**
 * Per-launch bearer token authentication for the internal MCP HTTP servers.
 *
 * The five Nimbalyst MCP HTTP servers (`httpServer`, `sessionNamingServer`,
 * `extensionDevServer`, `sessionContextServer`, `metaAgentServer`) all listen on
 * 127.0.0.1 with no transport-level authentication. Without a bearer token, any
 * page open in the user's browser can fire a fetch at the localhost port and
 * trigger tool execution side effects, even though CORS prevents reading the
 * response.
 *
 * Why: every browser tab the user has open shares the loopback interface with
 * the MCP servers. Bearer-token auth (a known SDK feature on the Claude Agent
 * SDK and Codex SDK) is the standard mitigation. The token is generated in
 * memory at startup, shared across all five servers (same process), and
 * plumbed to the SDK subprocesses through the existing `headers` field on the
 * MCP server config. It is never persisted -- it dies with the process.
 */
import { randomBytes, timingSafeEqual } from "crypto";
import { IncomingMessage } from "http";
import path from "path";

let mcpAuthToken: string | null = null;
const sessionAuthorityByCredential = new Map<string, Readonly<McpSessionAuthority>>();
const credentialByAuthorityKey = new Map<string, string>();

export interface McpSessionAuthority {
  actorSessionId: string;
  /** Exact host/storage spelling used for every operational lookup. */
  workspacePath: string;
  /** Normalized comparison identity used only for authorization equality. */
  workspaceComparisonPath: string;
}

export function canonicalizeMcpWorkspacePath(workspacePath: string): string {
  const resolved = path.resolve(workspacePath.trim()).replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function resetSessionCredentials(): void {
  sessionAuthorityByCredential.clear();
  credentialByAuthorityKey.clear();
}

/**
 * Generate a fresh per-launch token. Called once at startup before any MCP
 * server starts. Returns the new token.
 */
export function generateMcpAuthToken(): string {
  resetSessionCredentials();
  mcpAuthToken = randomBytes(32).toString("hex");
  return mcpAuthToken;
}

/**
 * Return the current token, or null if generateMcpAuthToken has not been
 * called yet. Used by main-process plumbing that hands the token to providers.
 */
export function getMcpAuthToken(): string | null {
  return mcpAuthToken;
}

/**
 * Set the token directly. Only for tests.
 */
export function setMcpAuthTokenForTest(token: string | null): void {
  resetSessionCredentials();
  mcpAuthToken = token;
}

/**
 * Issue an opaque process-lifetime credential bound to exactly one actor and
 * canonical workspace. Repeated config builds for the same tuple reuse the
 * credential; no caller-controlled identity is encoded in the token itself.
 */
export function issueMcpSessionCredential(
  actorSessionId: string,
  workspacePath: string,
): string {
  if (!mcpAuthToken) throw new Error("MCP authentication is not initialized");
  const normalizedActor = actorSessionId.trim();
  const operationalWorkspacePath = workspacePath.trim();
  const workspaceComparisonPath = canonicalizeMcpWorkspacePath(operationalWorkspacePath);
  if (!normalizedActor || !operationalWorkspacePath || !workspaceComparisonPath) {
    throw new Error("MCP session authority is incomplete");
  }
  const key = `${normalizedActor}\u0000${workspaceComparisonPath}`;
  const existing = credentialByAuthorityKey.get(key);
  if (existing) return existing;

  let credential: string;
  do {
    credential = randomBytes(32).toString("hex");
  } while (credential === mcpAuthToken || sessionAuthorityByCredential.has(credential));
  const authority = Object.freeze({
    actorSessionId: normalizedActor,
    workspacePath: operationalWorkspacePath,
    workspaceComparisonPath,
  });
  credentialByAuthorityKey.set(key, credential);
  sessionAuthorityByCredential.set(credential, authority);
  return credential;
}

/**
 * Revoke every opaque credential for one host actor. Session completion is a
 * security boundary, not merely a document-state update: recreating the same
 * actor/workspace tuple must require a newly minted credential.
 */
export function revokeMcpSessionCredentials(actorSessionId: string): void {
  const normalizedActor = actorSessionId.trim();
  if (!normalizedActor) return;
  for (const [credential, authority] of sessionAuthorityByCredential) {
    if (authority.actorSessionId !== normalizedActor) continue;
    sessionAuthorityByCredential.delete(credential);
    const key = `${authority.actorSessionId}\u0000${authority.workspaceComparisonPath}`;
    if (credentialByAuthorityKey.get(key) === credential) {
      credentialByAuthorityKey.delete(key);
    }
  }
}

/**
 * Validate that a request carries the configured bearer token.
 *
 * Accepts the token in either:
 *   1. `Authorization: Bearer <token>` header (preferred, used by SDK clients)
 *   2. `?token=<token>` query string (fallback for transport variants that drop
 *      headers across reconnects)
 *
 * Uses `timingSafeEqual` to avoid leaking token length / prefix via timing.
 * Returns `false` if the server has not yet generated a token (defense in
 * depth -- callers should never reach the MCP servers before startup wires the
 * token, but if it happens, fail closed).
 */
export function requireMcpAuth(req: IncomingMessage): boolean {
  if (!mcpAuthToken) {
    return false;
  }

  const provided = extractToken(req);
  if (!provided) {
    return false;
  }

  if (constantTimeEquals(provided, mcpAuthToken)) return true;
  return sessionAuthorityByCredential.has(provided);
}

/** Return the immutable actor/workspace tuple for a scoped request token. */
export function getMcpSessionAuthority(
  req: IncomingMessage,
): Readonly<McpSessionAuthority> | null {
  const provided = extractToken(req);
  if (!provided) return null;
  return sessionAuthorityByCredential.get(provided) ?? null;
}

/**
 * Authenticate an actor-bearing transport initialization. The process-wide
 * bearer deliberately returns null here: it authenticates localhost plumbing,
 * but cannot establish a session authority tuple. Query conflicts and missing
 * host state collapse to the same null result for non-enumerating refusal.
 */
export function authorizeMcpSessionRequest(
  req: IncomingMessage,
  requestedSessionId: string | undefined,
  hostAuthority: Readonly<{ actorSessionId: string; workspacePath: string }> | null | undefined,
): Readonly<McpSessionAuthority> | null {
  if (!requestedSessionId || !hostAuthority) return null;
  const credentialAuthority = getMcpSessionAuthority(req);
  if (!credentialAuthority) return null;
  const currentOperationalWorkspacePath = hostAuthority.workspacePath.trim();
  const currentWorkspaceComparisonPath = canonicalizeMcpWorkspacePath(
    currentOperationalWorkspacePath,
  );
  if (
    credentialAuthority.actorSessionId !== requestedSessionId ||
    hostAuthority.actorSessionId !== credentialAuthority.actorSessionId ||
    currentWorkspaceComparisonPath !== credentialAuthority.workspaceComparisonPath
  ) {
    return null;
  }
  // The credential proves only the actor/comparison tuple. Operational path
  // spelling always comes from the current host-owned record so cached token
  // state cannot retain authority or route through a stale alias.
  return Object.freeze({
    actorSessionId: hostAuthority.actorSessionId,
    workspacePath: currentOperationalWorkspacePath,
    workspaceComparisonPath: currentWorkspaceComparisonPath,
  });
}

/** Validate a follow-up request against a server-created transport binding. */
export function authorizeMcpTransportRequest(
  req: IncomingMessage,
  expected: Readonly<McpSessionAuthority> | null,
  hostAuthority: Readonly<{ actorSessionId: string; workspacePath: string }> | null = null,
): boolean {
  const actual = getMcpSessionAuthority(req);
  if (!expected) return actual === null;
  const current = authorizeMcpSessionRequest(
    req,
    expected.actorSessionId,
    hostAuthority,
  );
  return Boolean(
    actual &&
    current &&
    current.actorSessionId === expected.actorSessionId &&
    current.workspaceComparisonPath === expected.workspaceComparisonPath &&
    // The server instance and its tool closures were constructed with this
    // exact host path. Even an equivalent alias requires a new transport so an
    // established connection can never keep operating on stale raw routing.
    current.workspacePath === expected.workspacePath
  );
}

function extractToken(req: IncomingMessage): string | null {
  const authHeader = req.headers["authorization"];
  if (typeof authHeader === "string") {
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (match) {
      return match[1].trim();
    }
  }

  const url = req.url ?? "";
  const queryIndex = url.indexOf("?");
  if (queryIndex >= 0) {
    const params = new URLSearchParams(url.slice(queryIndex + 1));
    const tokenParam = params.get("token");
    if (tokenParam) {
      return tokenParam;
    }
  }

  return null;
}

function constantTimeEquals(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) {
    // timingSafeEqual requires equal-length inputs. Compare against `aBuf`
    // itself so the work performed is independent of the user-supplied length.
    timingSafeEqual(aBuf, aBuf);
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}
