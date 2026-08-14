import { describe, expect, it } from "vitest";

import type { ClientMessage, RequestMobilePushMessage } from "../personal.js";

// Client-side protocol extension for upstream issue #704: optional `force`/
// `reason` fields on `RequestMobilePushMessage`. These are primarily
// type-level regression tests -- the file fails to compile (not just fails
// at runtime) if the fields are ever made required or removed, protecting
// the backwards-compatibility contract this change is built around. This is
// a protocol-only change: the sync server does not yet honor `force`/
// `reason`, so this has no effect on delivered behavior until a companion
// server-side change lands.

describe("RequestMobilePushMessage force/reason fields (#704 protocol extension)", () => {
  it("accepts a message with force/reason omitted (pre-existing shape, still valid)", () => {
    const message: RequestMobilePushMessage = {
      type: "requestMobilePush",
      sessionId: "session-1",
      title: "Title",
      body: "Body",
    };
    expect(message.force).toBeUndefined();
    expect(message.reason).toBeUndefined();
  });

  it("accepts a message with requestingDeviceId but no force/reason", () => {
    const message: RequestMobilePushMessage = {
      type: "requestMobilePush",
      sessionId: "session-1",
      title: "Title",
      body: "Body",
      requestingDeviceId: "device-1",
    };
    expect(message.force).toBeUndefined();
    expect(message.reason).toBeUndefined();
  });

  it("accepts a message with force/reason set for explicit agent-attention flows", () => {
    const message: RequestMobilePushMessage = {
      type: "requestMobilePush",
      sessionId: "session-1",
      title: "Title",
      body: "Body",
      force: true,
      reason: "agent_attention",
    };
    expect(message.force).toBe(true);
    expect(message.reason).toBe("agent_attention");
  });

  it("is assignable to the ClientMessage union with force/reason present", () => {
    const message: ClientMessage = {
      type: "requestMobilePush",
      sessionId: "session-1",
      title: "Title",
      body: "Body",
      force: true,
      reason: "agent_completion",
    };
    expect(message.type).toBe("requestMobilePush");
  });
});
