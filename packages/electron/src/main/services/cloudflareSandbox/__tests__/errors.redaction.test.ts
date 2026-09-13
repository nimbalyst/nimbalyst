// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

// `vi.mock` is hoisted above the imports, so the spy has to be created inside
// the factory rather than captured from an outer const.
vi.mock("../../../utils/logger", () => ({
  logger: { main: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } },
}));

import {
  classifyWranglerFailure,
  sandboxError,
  SandboxOperationError,
  toSandboxError,
} from "../errors";
import { logger } from "../../../utils/logger";

const warn = vi.mocked(logger.main.warn);

/** A failure shaped like the ones Wrangler actually produces. */
const TOKEN = "v1.0-abcdef0123456789abcdef0123456789-secret";
const TOKEN_BEARING_FAILURE = new Error(
  `Failed to fetch https://api.cloudflare.com/client/v4/accounts?code=${TOKEN} ` +
    `- headers: {"Authorization":"Bearer ${TOKEN}"} - not authenticated`
);

beforeEach(() => warn.mockClear());

describe("credential redaction", () => {
  it.each([
    "Request timed out after 100000 ms",
    "Upload exceeds 10000 bytes",
    "Network failure at https://api.cloudflare.com/client/v4/accounts/{account_id}/workers",
  ])("preserves the fallback for unrelated diagnostics: %s", (raw) => {
    expect(classifyWranglerFailure(raw, "deploy-failed")).toBe("deploy-failed");
  });

  it.each([
    "[code: 10000]",
    "Cloudflare API error code 10000",
    '{"errors":[{"code":10000,"message":"Rejected"}]}',
  ])("recognizes an explicit authentication error code: %s", (raw) => {
    expect(classifyWranglerFailure(raw)).toBe("not-authenticated");
  });

  it.each([
    "This Worker does not exist on this account. [code: 10090]",
    '{"errors":[{"code":10090,"message":"workers.api.error.service_not_found"}]}',
  ])("recognizes a worker that is already gone, so a retried delete can finish cleanup: %s", (raw) => {
    expect(classifyWranglerFailure(raw)).toBe("worker-missing");
  });

  it.each([
    "In a non-interactive environment, it is mandatory to specify an account ID",
    "Please set the appropriate `account_id` in your wrangler.json file",
  ])("recognizes account selection instructions: %s", (raw) => {
    expect(classifyWranglerFailure(raw)).toBe("account-required");
  });

  it("recognizes missing credentials in non-interactive Wrangler without leaking diagnostics", () => {
    const error = toSandboxError(
      new Error(
        `Could not authenticate because no credentials were found and the environment is non-interactive ${TOKEN}`
      ),
      "deploy-failed"
    );

    expect(error.code).toBe("not-authenticated");
    expect(error.message).toMatch(/sign in again/i);
    expect(error.message).not.toContain(TOKEN);
    expect(warn.mock.calls.flat().join(" ")).not.toContain(TOKEN);
  });

  it("keeps token material out of the message shown to the user", () => {
    const error = toSandboxError(TOKEN_BEARING_FAILURE);

    expect(error.code).toBe("not-authenticated");
    expect(error.message).not.toContain(TOKEN);
    expect(error.message).not.toMatch(
      /Authorization|Bearer|api\.cloudflare\.com/i
    );
  });

  it("keeps token material out of the log, which outlives the failure on disk", () => {
    toSandboxError(TOKEN_BEARING_FAILURE);

    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toMatch(/Authorization|Bearer|https?:\/\//i);
  });

  it("still logs enough to tell which step failed", () => {
    sandboxError("deploy-failed", "deploy");

    expect(warn.mock.calls.flat().join(" ")).toMatch(/deploy-failed.*deploy/);
  });

  it("logs only the curated event label carried by a thrown operation error", () => {
    toSandboxError(new SandboxOperationError("not-authenticated", "whoami"));

    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).toContain("whoami");
    expect(logged).toContain("not-authenticated");
  });

  it("does not leak an arbitrary exception message even when unclassifiable", () => {
    toSandboxError(new Error(`totally unexpected ${TOKEN}`));

    expect(warn.mock.calls.flat().join(" ")).not.toContain(TOKEN);
  });
});

describe("node error codes", () => {
  // A code that is not in the MESSAGES table is not recognised as a carrier and
  // silently normalises to `unknown`, which is how the UI loses the difference
  // between "the container slept" and "something went wrong".
  it.each(["node-not-provisioned", "node-start-failed", "grant-failed"] as const)(
    "preserves %s through normalisation, with a message",
    (code) => {
      const error = toSandboxError(new SandboxOperationError(code, "node-op"));
      expect(error.code).toBe(code);
      expect(error.message.length).toBeGreaterThan(0);
    },
  );
});
