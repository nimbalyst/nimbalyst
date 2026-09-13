// @vitest-environment node
import { describe, expect, it } from "vitest";

import { parseWhoamiJson } from "../profiles";
import { parseAuthListTable } from "../profileBindings";
import { SandboxOperationError } from "../errors";
import { getProfileWorkingDir, isValidProfileName } from "../wranglerPaths";

it("rejects flag-like profile names while preserving other Wrangler characters", () => {
  for (const name of ["--help", "-h", "-work", "-"]) {
    expect(isValidProfileName(name)).toBe(false);
    expect(() => getProfileWorkingDir(name)).toThrow(/Invalid Wrangler profile/);
  }
  for (const name of ["work-team", "_work", "A_09-", "default"]) {
    expect(isValidProfileName(name)).toBe(true);
  }
});

describe("parseAuthListTable", () => {
  const table = [
    "┌─────────┬───────────────────────┐",
    "│ Profile │ Bound Directories     │",
    "├─────────┼───────────────────────┤",
    "│ work    │ /Users/x/a, /Users/x/b │",
    "├─────────┼───────────────────────┤",
    "│ personal│ -                     │",
    "└─────────┴───────────────────────┘",
  ].join("\n");

  it("reads profile names and splits their bound directories", () => {
    expect(parseAuthListTable(table)).toEqual([
      {
        name: "work",
        boundDirectories: ["/Users/x/a", "/Users/x/b"],
        ambiguous: false,
      },
      { name: "personal", boundDirectories: [], ambiguous: false },
    ]);
  });

  it("treats the empty-state message as no profiles rather than a parse failure", () => {
    expect(
      parseAuthListTable(
        "No profiles found. Run `wrangler login` to get started."
      )
    ).toEqual([]);
  });

  it("survives ANSI colour that outlives NO_COLOR", () => {
    const coloured = table.replace("work", "[34mwork[39m");

    expect(
      parseAuthListTable(coloured).map((row: { name: string }) => row.name)
    ).toContain("work");
  });
});

describe("parseWhoamiJson", () => {
  it("extracts identity and accounts", () => {
    const output = JSON.stringify({
      loggedIn: true,
      authType: "OAuth Token",
      email: "user@example.com",
      accounts: [{ id: "acct-1", name: "Work" }],
      tokenPermissions: ["account:read"],
    });

    expect(parseWhoamiJson(output)).toEqual({
      email: "user@example.com",
      accounts: [{ id: "acct-1", name: "Work" }],
    });
  });

  it("accepts the account_id/account_name shape rather than reporting no accounts", () => {
    const output = JSON.stringify({
      loggedIn: true,
      email: null,
      accounts: [{ account_id: "acct-9", account_name: "Legacy" }],
    });

    expect(parseWhoamiJson(output).accounts).toEqual([
      { id: "acct-9", name: "Legacy" },
    ]);
  });

  it("treats loggedIn:false as not authenticated", () => {
    expect(() => parseWhoamiJson(JSON.stringify({ loggedIn: false }))).toThrow(
      SandboxOperationError
    );
  });

  it("finds the JSON object even when a banner is printed before it", () => {
    const output = `Getting User settings...\n${JSON.stringify({
      loggedIn: true,
      email: "a@b.c",
      accounts: [],
    })}\n`;

    expect(parseWhoamiJson(output).email).toBe("a@b.c");
  });

  it("does not leak token permissions into the parsed result", () => {
    const parsed = parseWhoamiJson(
      JSON.stringify({
        loggedIn: true,
        email: "a@b.c",
        accounts: [],
        tokenPermissions: ["x"],
      })
    );

    expect(Object.keys(parsed).sort()).toEqual(["accounts", "email"]);
  });
});
