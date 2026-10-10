import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

/**
 * Connect an MCP server to a transport, running `onClose` when it closes.
 *
 * `onclose` must be in place before `connect()`. `Protocol.connect()` saves
 * whatever the transport already holds and wraps it with its own close logic,
 * which aborts every in-flight request handler. Assigning `onclose` afterwards
 * replaces that wrapper: cleanup still runs, but a tool handler waiting on
 * `extra.signal` (AskUserQuestion, RequestUserInput, the commit proposal) never
 * aborts, so its waiter and the session's pending-prompt state leak (#1557).
 */
export function connectMcpTransport(
  server: Pick<Server, "connect">,
  transport: Transport,
  onClose: () => void,
): Promise<void> {
  transport.onclose = onClose;
  return server.connect(transport);
}
