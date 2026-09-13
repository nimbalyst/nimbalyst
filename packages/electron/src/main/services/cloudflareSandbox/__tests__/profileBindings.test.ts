// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  assertResolvesTo,
  isReservedProfileName,
  parseAuthListTable,
  resolveProfileForDirectory,
} from "../profileBindings";
import { SandboxOperationError } from "../errors";

describe("reserved profile names", () => {
  it("knows the names wrangler refuses to create or bind, case-insensitively", () => {
    expect(isReservedProfileName("default")).toBe(true);
    expect(isReservedProfileName("Staging")).toBe(true);
    expect(isReservedProfileName("work")).toBe(false);
  });
});

describe("resolveProfileForDirectory", () => {
  const bindings = [
    { name: "work", boundDirectories: ["/Users/x/work"], ambiguous: false },
    {
      name: "deep",
      boundDirectories: ["/Users/x/work/nested"],
      ambiguous: false,
    },
  ];

  it("lets the longest bound path win, matching wrangler", () => {
    expect(
      resolveProfileForDirectory("/Users/x/work/nested/a", bindings).profile
    ).toBe("deep");
  });

  it("matches only on a path-separator boundary, not a bare prefix", () => {
    // "/Users/x/workspace" must not match a binding on "/Users/x/work".
    expect(
      resolveProfileForDirectory("/Users/x/workspace", bindings).profile
    ).toBe("default");
  });

  it("falls back to the default profile when nothing binds the directory", () => {
    const resolved = resolveProfileForDirectory("/tmp/elsewhere", bindings);

    expect(resolved).toMatchObject({ profile: "default", source: "default" });
  });

  it("refuses to guess when the binding map could not be parsed unambiguously", () => {
    const ambiguous = parseAuthListTable(
      [
        "┌─────────┬───────────────────┐",
        "│ Profile │ Bound Directories │",
        "├─────────┼───────────────────┤",
        "│ work    │ /Users/x/a, b/c   │",
        "└─────────┴───────────────────┘",
      ].join("\n")
    );

    expect(ambiguous[0]?.ambiguous).toBe(true);
    expect(() =>
      resolveProfileForDirectory("/tmp/anywhere", ambiguous)
    ).toThrow(SandboxOperationError);
  });
});

describe("assertResolvesTo", () => {
  it("rejects a default-profile directory that some ancestor binds to another profile", () => {
    // The default profile can never be bound (`auth activate default` is
    // refused), so it is only reachable where nothing above it is bound.
    // Running here would silently authenticate as "work".
    const bindings = [
      { name: "work", boundDirectories: ["/Users/x"], ambiguous: false },
    ];

    expect(() =>
      assertResolvesTo("/Users/x/nimbalyst/default", "default", bindings)
    ).toThrow(SandboxOperationError);
  });

  it("accepts a default-profile directory nothing binds", () => {
    expect(() =>
      assertResolvesTo("/Users/x/nimbalyst/default", "default", [
        { name: "work", boundDirectories: ["/elsewhere"], ambiguous: false },
      ])
    ).not.toThrow();
  });

  it("accepts a named-profile directory bound to exactly that profile", () => {
    expect(() =>
      assertResolvesTo("/n/profiles/work", "work", [
        {
          name: "work",
          boundDirectories: ["/n/profiles/work"],
          ambiguous: false,
        },
      ])
    ).not.toThrow();
  });
});
