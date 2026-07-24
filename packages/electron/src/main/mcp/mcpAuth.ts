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

let mcpAuthToken: string | null = null;

/**
 * Generate a fresh per-launch token. Called once at startup before any MCP
 * server starts. Returns the new token.
 */
export function generateMcpAuthToken(): string {
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
  mcpAuthToken = token;
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

  return constantTimeEquals(provided, mcpAuthToken);
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
