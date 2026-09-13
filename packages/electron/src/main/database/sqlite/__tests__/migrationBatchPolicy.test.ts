// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  estimatePayloadBytes,
  MigrationBatchPolicy,
} from "../migrationBatchPolicy";

describe("migration batch policy", () => {
  it("shrinks for elapsed time or bytes, recovers gradually, and respects a table ceiling", () => {
    const policy = new MigrationBatchPolicy(500);
    policy.succeeded(8_000, 100);
    expect(policy.limit).toBe(125);
    policy.succeeded(100, 8 * 1024 * 1024);
    expect(policy.limit).toBe(62);
    policy.timedOut();
    expect(policy.limit).toBe(31);
    policy.succeeded(100, 100);
    policy.succeeded(100, 100);
    expect(policy.limit).toBe(31);
    policy.succeeded(100, 100);
    expect(policy.limit).toBe(38);
    for (let i = 0; i < 100; i++) policy.succeeded(100, 100);
    expect(policy.limit).toBe(500);
    for (let i = 0; i < 20; i++) policy.timedOut();
    expect(policy.limit).toBe(1);
    expect(new MigrationBatchPolicy(10).limit).toBe(10);
    expect(() => new MigrationBatchPolicy(0)).toThrow(/positive integer/);
  });

  it("accounts for nested JSON and binary views without expanding bytes to numeric JSON properties", () => {
    const payload = {
      text: "é",
      nested: [true, 1, null],
      blob: Buffer.alloc(1024),
      date: new Date(0),
    };
    expect(estimatePayloadBytes(payload)).toBe(
      4 + 2 + 6 + 8 + 8 + 4 + 4 + 1024 + 4 + 8
    );
    expect(estimatePayloadBytes(new Uint8Array(1024))).toBe(1024);
  });
});
