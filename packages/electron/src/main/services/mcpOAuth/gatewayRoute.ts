/**
 * Entry point the internal MCP HTTP server calls for `/mcp-remote/*`: the
 * route-scoped bearer check, then the gateway. Kept separate from httpServer.ts
 * so the gate itself is what the tests exercise.
 */
import { createHmac, timingSafeEqual } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import { getMcpAuthToken } from '../../mcp/mcpAuth';
import { logger } from '../../utils/logger';
import { GATEWAY_PATH_PREFIX, type McpRemoteGateway } from './gateway';

/**
 * The bearer a generated config entry carries for one gateway route: an HMAC
 * of the per-launch token and the route key. It opens only that route, not
 * the other routes or the first-party `/mcp` servers, so an entry persisted in
 * another tool's config file (Cursor's `~/.cursor/mcp.json`) or handed to one
 * agent grants no more than that one server. It stops working at restart,
 * when the launch token changes.
 */
export function gatewayRouteToken(launchToken: string, routeKey: string): string {
  return createHmac('sha256', launchToken).update(`mcp-remote-route:${routeKey}`).digest('hex');
}

function routeKeyOf(pathname: string): string {
  return pathname.slice(GATEWAY_PATH_PREFIX.length).replace(/\/+$/, '');
}

function hasRouteToken(req: IncomingMessage, pathname: string): boolean {
  const launchToken = getMcpAuthToken();
  if (!launchToken) {
    return false;
  }
  const header = req.headers.authorization;
  const provided = typeof header === 'string' ? /^Bearer\s+(\S+)$/i.exec(header.trim())?.[1] : undefined;
  if (!provided) {
    return false;
  }
  const expected = Buffer.from(gatewayRouteToken(launchToken, routeKeyOf(pathname)));
  const actual = Buffer.from(provided);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function isGatewayPath(pathname: string | null | undefined): pathname is string {
  return typeof pathname === 'string' && pathname.startsWith(GATEWAY_PATH_PREFIX);
}

export async function handleGatewayRequest(
  gateway: McpRemoteGateway,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<void> {
  if (!hasRouteToken(req, pathname)) {
    res.writeHead(401);
    res.end('Unauthorized');
    return;
  }
  try {
    await gateway.handle(req, res, pathname);
  } catch (error) {
    try {
      logger.mcp.warn('[MCP gateway] Request failed:', error instanceof Error ? error.name : 'unknown');
    } catch {
      // Logging must not mask the response.
    }
    if (!res.headersSent) {
      res.writeHead(502);
      res.end();
    } else {
      res.destroy();
    }
  }
}
