// @vitest-environment node
/**
 * When the client connection drops, a tool handler still waiting on the user
 * must see `extra.signal` abort: that is how AskUserQuestion, RequestUserInput
 * and the commit proposal settle and release their waiter. Uses the real SDK
 * `Server` over an in-memory transport, whose `close()` fires `onclose` exactly
 * as `SSEServerTransport` does when its response stream closes.
 */
import { describe, expect, it, vi } from "vitest";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CallToolRequestSchema,
  CallToolResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { connectMcpTransport } from "../connectMcpTransport";

describe("connectMcpTransport", () => {
  it("aborts an in-flight tool handler when the transport closes, and still runs cleanup", async () => {
    const server = new Server(
      { name: "test", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    let handlerStarted!: () => void;
    const started = new Promise<void>((resolve) => (handlerStarted = resolve));
    let aborted = false;
    server.setRequestHandler(CallToolRequestSchema, (_request, extra) => {
      handlerStarted();
      return new Promise((resolve) => {
        extra.signal.addEventListener("abort", () => {
          aborted = true;
          resolve({ content: [] });
        });
      });
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    let cleanedUp = false;
    await connectMcpTransport(server, serverTransport, () => {
      cleanedUp = true;
    });
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);

    const call = client
      .request({ method: "tools/call", params: { name: "wait", arguments: {} } }, CallToolResultSchema)
      .catch(() => undefined);
    await started;

    await serverTransport.close();

    await vi.waitFor(() => expect(aborted).toBe(true), { timeout: 1000 });
    expect(cleanedUp).toBe(true);
    await call;
  });
});
