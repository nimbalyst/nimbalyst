// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../utils/logger", () => ({
  logger: { main: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } },
}));

import { exportClaudeCredential } from "../claudeCredentialExport";

const CREDENTIAL = JSON.stringify({
  claudeAiOauth: {
    accessToken: "sk-ant-oat-example",
    refreshToken: "sk-ant-ort-example",
    expiresAt: 1_800_000_000_000,
    scopes: ["user:inference"],
    subscriptionType: "max",
  },
});

describe("exportClaudeCredential", () => {
  it("returns the keychain payload verbatim, trailing newline trimmed", async () => {
    const runSecurity = vi.fn(async (_args: string[]) => `${CREDENTIAL}\n`);

    const exported = await exportClaudeCredential({
      platform: "darwin",
      env: {},
      runSecurity,
      readCredentialsFile: async () => { throw new Error("must not read the file"); },
    });

    // Verbatim, not re-serialized: fields this codebase does not know about
    // have to survive the trip into the container.
    expect(exported).toBe(CREDENTIAL);
    expect(runSecurity).toHaveBeenCalledWith([
      "find-generic-password",
      "-s",
      "Claude Code-credentials",
      "-w",
    ]);
  });

  it("reads the config-dir-scoped keychain entry and does not fall back to the unscoped one", async () => {
    const runSecurity = vi.fn(async (_args: string[]) => CREDENTIAL);

    await exportClaudeCredential({
      platform: "darwin",
      env: { CLAUDE_CONFIG_DIR: "/Users/x/.claude-work" },
      runSecurity,
      readCredentialsFile: async () => { throw new Error("must not read the file"); },
    });

    expect(runSecurity).toHaveBeenCalledTimes(1);
    const serviceName = runSecurity.mock.calls[0][0][2];
    expect(serviceName).toMatch(/^Claude Code-credentials-[0-9a-f]{8}$/);
  });

  it("moves to the next keychain entry when one is absent", async () => {
    const runSecurity = vi.fn(async (args: string[]) => {
      if (args[2] === "Claude Code-credentials") throw new Error("could not be found");
      return CREDENTIAL;
    });

    await expect(
      exportClaudeCredential({
        platform: "darwin",
        env: {},
        runSecurity,
        readCredentialsFile: async () => { throw new Error("must not read the file"); },
      }),
    ).resolves.toBe(CREDENTIAL);
    expect(runSecurity).toHaveBeenCalledTimes(2);
  });

  it("treats a keychain entry with no access token as a miss and falls back to the file", async () => {
    const runSecurity = vi.fn(async (_args: string[]) => JSON.stringify({ claudeAiOauth: {} }));
    const readCredentialsFile = vi.fn(async (_path: string) => CREDENTIAL);

    await expect(
      exportClaudeCredential({ platform: "darwin", env: {}, runSecurity, readCredentialsFile }),
    ).resolves.toBe(CREDENTIAL);
  });

  it("reads the credentials file directly off darwin", async () => {
    const runSecurity = vi.fn(async (_args: string[]) => CREDENTIAL);
    const readCredentialsFile = vi.fn(async (_path: string) => CREDENTIAL);

    await expect(
      exportClaudeCredential({ platform: "linux", env: {}, runSecurity, readCredentialsFile }),
    ).resolves.toBe(CREDENTIAL);
    expect(runSecurity).not.toHaveBeenCalled();
    expect(readCredentialsFile.mock.calls[0][0]).toMatch(/\.credentials\.json$/);
  });

  it("fails with a sign-in message, never an error naming the credential store", async () => {
    await expect(
      exportClaudeCredential({
        platform: "darwin",
        env: {},
        runSecurity: async () => { throw new Error("could not be found"); },
        readCredentialsFile: async () => { throw new Error("ENOENT /Users/x/.claude/.credentials.json"); },
      }),
    ).rejects.toMatchObject({
      sandboxErrorCode: "not-authenticated",
      event: "claude-credential-missing",
    });
  });
});
