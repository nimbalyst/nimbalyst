// @vitest-environment node
import { describe, it, expect } from "vitest";
import { ensureMcpAcceptHeader } from "../httpServer";

describe("ensureMcpAcceptHeader", () => {
  it("passes through an already-compliant header", () => {
    expect(ensureMcpAcceptHeader("application/json, text/event-stream")).toBe(
      "application/json, text/event-stream",
    );
  });

  it("passes through a compliant header regardless of order", () => {
    expect(ensureMcpAcceptHeader("text/event-stream, application/json")).toBe(
      "text/event-stream, application/json",
    );
  });

  // Antigravity's Cascade call_mcp_tool bridge sends this -- observed live
  // 2026-09-14, rejected by the SDK transport with a 406.
  it("corrects a missing Accept header", () => {
    expect(ensureMcpAcceptHeader(undefined)).toBe("application/json, text/event-stream");
  });

  it("corrects a header naming only application/json", () => {
    expect(ensureMcpAcceptHeader("application/json")).toBe("application/json, text/event-stream");
  });

  it("corrects a header naming only text/event-stream", () => {
    expect(ensureMcpAcceptHeader("text/event-stream")).toBe("application/json, text/event-stream");
  });

  it("corrects an unrelated Accept header", () => {
    expect(ensureMcpAcceptHeader("*/*")).toBe("application/json, text/event-stream");
  });
});
