// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../wranglerCli", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../wranglerCli")>();
  return { ...actual, runWrangler: vi.fn() };
});
vi.mock("fs/promises", () => ({ mkdir: vi.fn(async () => undefined) }));
vi.mock("../wranglerPaths", () => ({
  getProfileWorkingDir: (name: string) => `/n/profiles/${name}`,
  isValidProfileName: (name: unknown) =>
    typeof name === "string" && /^[a-zA-Z0-9_-]+$/.test(name),
}));
vi.mock("../../../utils/logger", () => ({
  logger: { main: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } },
}));

import { createOrReauthenticateProfile, whoami } from "../profiles";
import { runWrangler } from "../wranglerCli";

const WHOAMI = JSON.stringify({
  loggedIn: true,
  email: "user@example.com",
  accounts: [{ id: "a".repeat(32), name: "Work" }],
});

/** `auth list` output binding a directory to `name`. */
function authList(rows: Array<[string, string]>): string {
  return [
    "┌─────────┬───────────────────┐",
    "│ Profile │ Bound Directories │",
    "├─────────┼───────────────────┤",
    ...rows.map(([name, dirs]) => `│ ${name} │ ${dirs} │`),
    "└─────────┴───────────────────┘",
  ].join("\n");
}

function calls(): string[][] {
  return vi.mocked(runWrangler).mock.calls.map(([args]) => args as string[]);
}

beforeEach(() => vi.clearAllMocks());

describe("whoami", () => {
  it("never passes --profile, because wrangler rejects that flag outright", async () => {
    vi.mocked(runWrangler).mockImplementation(async (args: string[]) =>
      args[0] === "auth"
        ? { stdout: authList([["work", "/n/profiles/work"]]), stderr: "" }
        : { stdout: WHOAMI, stderr: "" }
    );

    await whoami("work");

    const whoamiCall = calls().find((args) => args[0] === "whoami");
    expect(whoamiCall).toEqual(["whoami", "--json"]);
    expect(whoamiCall).not.toContain("--profile");
  });

  it("runs from the directory bound to the profile, which is how the profile is selected", async () => {
    vi.mocked(runWrangler).mockImplementation(async (args: string[]) =>
      args[0] === "auth"
        ? { stdout: authList([["work", "/n/profiles/work"]]), stderr: "" }
        : { stdout: WHOAMI, stderr: "" }
    );

    await whoami("work");

    const [, options] = vi
      .mocked(runWrangler)
      .mock.calls.find(([args]) => (args as string[])[0] === "whoami") as [
      string[],
      { cwd?: string }
    ];
    expect(options.cwd).toBe("/n/profiles/work");
  });

  it("binds a pre-existing profile the first time it is used, not only at creation", async () => {
    let bound = false;
    vi.mocked(runWrangler).mockImplementation(async (args: string[]) => {
      if (args[0] === "auth" && args[1] === "list") {
        return {
          stdout: authList(
            bound ? [["work", "/n/profiles/work"]] : [["work", "-"]]
          ),
          stderr: "",
        };
      }
      if (args[0] === "auth" && args[1] === "activate") {
        bound = true;
        return { stdout: "", stderr: "" };
      }
      return { stdout: WHOAMI, stderr: "" };
    });

    await whoami("work");

    expect(calls()).toContainEqual([
      "auth",
      "activate",
      "work",
      "/n/profiles/work",
    ]);
  });

  it("refuses when an ancestor binding means the default profile is unreachable", async () => {
    vi.mocked(runWrangler).mockImplementation(async (args: string[]) =>
      args[0] === "auth"
        ? { stdout: authList([["work", "/n"]]), stderr: "" }
        : { stdout: WHOAMI, stderr: "" }
    );

    await expect(whoami("default")).rejects.toThrow();
    expect(calls().some((args) => args[0] === "whoami")).toBe(false);
  });
});

describe("createOrReauthenticateProfile", () => {
  it("uses plain `login` for the default profile, which cannot be created or take --profile", async () => {
    vi.mocked(runWrangler).mockImplementation(async (args: string[]) =>
      args[0] === "auth"
        ? { stdout: authList([]), stderr: "" }
        : { stdout: WHOAMI, stderr: "" }
    );

    await createOrReauthenticateProfile("default", true);

    expect(calls()).toContainEqual(["login"]);
    expect(calls().some((args) => args.includes("--profile"))).toBe(false);
    expect(calls().some((args) => args[1] === "create")).toBe(false);
  });

  it("uses `auth create` for a named profile", async () => {
    vi.mocked(runWrangler).mockImplementation(async (args: string[]) =>
      args[0] === "auth"
        ? { stdout: authList([["work", "/n/profiles/work"]]), stderr: "" }
        : { stdout: WHOAMI, stderr: "" }
    );

    await createOrReauthenticateProfile("work", true);

    expect(calls()).toContainEqual(["auth", "create", "work"]);
  });

  it("refuses to sign in to the other reserved name, which no command can reach", async () => {
    vi.mocked(runWrangler).mockResolvedValue({
      stdout: authList([]),
      stderr: "",
    });

    await expect(
      createOrReauthenticateProfile("staging", true)
    ).rejects.toThrow();
    expect(
      calls().some((args) => args[0] === "login" || args[1] === "create")
    ).toBe(false);
  });

  it("will not silently take over an existing profile without an explicit re-auth", async () => {
    vi.mocked(runWrangler).mockResolvedValue({
      stdout: authList([["work", "-"]]),
      stderr: "",
    });

    await expect(
      createOrReauthenticateProfile("work", false)
    ).rejects.toThrow();
    expect(calls().some((args) => args[1] === "create")).toBe(false);
  });
});

it("serializes profile binding writes when two windows resolve profiles together", async () => {
  const bindings: Array<[string, string]> = [];
  let writing = 0;
  let maxWriting = 0;
  vi.mocked(runWrangler).mockImplementation(async (args: string[]) => {
    if (args[1] === "activate") {
      writing++;
      maxWriting = Math.max(maxWriting, writing);
      await new Promise((resolve) => setTimeout(resolve, 5));
      bindings.push([args[2], args[3]]);
      writing--;
      return { stdout: "", stderr: "" };
    }
    return {
      stdout: args[0] === "whoami" ? WHOAMI : authList(bindings),
      stderr: "",
    };
  });
  await Promise.all([whoami("work"), whoami("personal")]);
  expect(maxWriting).toBe(1);
});
