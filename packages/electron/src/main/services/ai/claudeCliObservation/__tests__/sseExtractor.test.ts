import { describe, it, expect } from "vitest";
import { extractSSEEvents } from "../sseExtractor";

describe("extractSSEEvents", () => {
  it("parses a complete event/data block", () => {
    const buf = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
    const { complete, remainder } = extractSSEEvents(buf);
    expect(complete).toHaveLength(1);
    expect(complete[0].event).toBe("message_stop");
    expect(complete[0].parsed).toEqual({ type: "message_stop" });
    expect(remainder).toBe("");
  });

  it("holds a trailing partial block as the remainder", () => {
    const buf = 'event: a\ndata: {"x":1}\n\nevent: b\ndata: {"y":2';
    const { complete, remainder } = extractSSEEvents(buf);
    expect(complete).toHaveLength(1);
    expect(complete[0].parsed).toEqual({ x: 1 });
    expect(remainder).toBe('event: b\ndata: {"y":2');
  });

  it("reassembles an event split across two chunks", () => {
    let buf = "";
    const all: unknown[] = [];
    const feed = (chunk: string) => {
      buf += chunk;
      const r = extractSSEEvents(buf);
      buf = r.remainder;
      r.complete.forEach((e) => all.push(e.parsed));
    };
    feed('event: content_block_delta\ndata: {"type":"content_bl');
    expect(all).toHaveLength(0); // nothing complete yet
    feed('ock_delta","index":0}\n\n');
    expect(all).toEqual([{ type: "content_block_delta", index: 0 }]);
  });

  it("leaves non-JSON data with parsed undefined and ignores blank blocks", () => {
    const buf = "data: [DONE]\n\n\n\n";
    const { complete } = extractSSEEvents(buf);
    expect(complete).toHaveLength(1);
    expect(complete[0].data).toBe("[DONE]");
    expect(complete[0].parsed).toBeUndefined();
  });
});
