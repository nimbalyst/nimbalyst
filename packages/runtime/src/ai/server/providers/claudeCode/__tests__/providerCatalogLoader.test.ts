import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PROVIDER_CATALOG_SCHEMA_VERSION,
  resolveProviderCatalogSnapshot,
  type ProviderCatalogEntry,
} from "../providerCatalog";
import {
  LEGACY_OLLAMA_BACKENDS_FILE,
  PROVIDER_CATALOG_OVERLAY_FILE,
  loadProviderCatalogFromDirectory,
  migrateLegacyOllamaBackends,
} from "../providerCatalogLoader";

const tempDirectories: string[] = [];

function makeDirectory(): string {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "nimbalyst-catalog-")
  );
  tempDirectories.push(directory);
  return directory;
}

function makeDefault(id: string): ProviderCatalogEntry {
  return {
    id,
    provider: "ollama",
    harness: { id: "claude-agent", order: 10 },
    family: { id: "test-family", order: 10 },
    displayName: id,
    model: {
      persistedId: `claude-code:ollama-${id}`,
      persistedIdNamespace: "claude-code:ollama-",
      providerModelId: `${id}:cloud`,
      upstreamModel: `openai/${id}:cloud`,
      version: "1",
      contextWindowSeedTokens: 128_000,
    },
    capabilities: {
      mainSession: true,
      subagent: true,
      consultation: true,
      tools: true,
      vision: false,
    },
    interfaces: [
      {
        id: "claude-agent-proxy",
        kind: "http",
        consumers: [
          "claude-agent-main",
          "claude-agent-subagent",
          "consultation",
        ],
        protocol: "anthropic-messages",
        transportProfile: "anthropic-compatible-proxy",
        authProfile: "credential-reference",
        endpoint: "http://127.0.0.1:4002",
        upstreamEndpoint: "https://ollama.com/v1",
        credentialRef: "nimbalyst.local-proxy",
        modelAlias: "claude-sonnet-4-5-20250929",
        contextTelemetry: {
          adapterId: "claude-agent-sdk-parent-v1",
          windowPolicy: "runtime-then-model-seed",
        },
      },
    ],
    controls: {},
  };
}

function makeLegacy(id: string) {
  return {
    id,
    persistedModel: `claude-code:ollama-${id}`,
    provider: "ollama",
    model: `${id}:cloud`,
    upstreamModel: `openai/${id}:cloud`,
    upstreamBaseUrl: "https://ollama.com/v1",
    baseUrl: "http://127.0.0.1:4002",
    authToken: "sk-nim-local-proxy",
    claudeModelAlias: "claude-sonnet-4-5-20250929",
  };
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("provider catalog legacy migration and loading", () => {
  it("preserves valid legacy additions and overrides while recording removed defaults as disables", () => {
    const defaults = [makeDefault("kept"), makeDefault("removed")];
    const migration = migrateLegacyOllamaBackends(
      [makeLegacy("kept"), makeLegacy("user-added")],
      defaults
    );

    expect(migration.overlay).toMatchObject({
      schemaVersion: PROVIDER_CATALOG_SCHEMA_VERSION,
      entries: [
        {
          id: "kept",
          patch: { model: { persistedId: "claude-code:ollama-kept" } },
        },
        { id: "removed", disabled: true },
        {
          id: "user-added",
          patch: { model: { persistedId: "claude-code:ollama-user-added" } },
        },
      ],
    });
    expect(migration.errors).toEqual([]);
    expect(
      migrateLegacyOllamaBackends(
        [makeLegacy("kept"), makeLegacy("user-added")],
        defaults
      )
    ).toEqual(migration);
  });

  it("writes one overlay, preserves the legacy file, and reloads idempotently", () => {
    const directory = makeDirectory();
    const migrationDefaults = [makeDefault("kept"), makeDefault("removed")];
    const upgradedKept = makeDefault("kept");
    upgradedKept.model.contextWindowSeedTokens = 256_000;
    upgradedKept.controls = {
      effort: {
        persistenceKey: "brain.effort",
        allowedValues: ["low", "high"],
        defaultValue: "high",
        mappings: [
          {
            interfaceId: "claude-agent-proxy",
            target: "launch.effort-level",
            values: [
              { storedValue: "low", resolvedValue: "low" },
              { storedValue: "high", resolvedValue: "high" },
            ],
          },
        ],
      },
    };
    const upgradedDefaults = [
      upgradedKept,
      makeDefault("removed"),
      makeDefault("new-default"),
    ];
    const legacyPath = path.join(directory, LEGACY_OLLAMA_BACKENDS_FILE);
    const legacyText = `${JSON.stringify(
      [makeLegacy("kept"), makeLegacy("user-added")],
      null,
      2
    )}\n`;
    fs.writeFileSync(legacyPath, legacyText, "utf-8");

    const first = loadProviderCatalogFromDirectory(
      directory,
      migrationDefaults
    );
    const overlayPath = path.join(directory, PROVIDER_CATALOG_OVERLAY_FILE);
    const overlayAfterFirstLoad = fs.readFileSync(overlayPath, "utf-8");
    const second = loadProviderCatalogFromDirectory(
      directory,
      upgradedDefaults
    );

    expect(first.migration).toMatchObject({
      performed: true,
      sourcePreserved: true,
    });
    expect(second.migration).toMatchObject({
      performed: false,
      sourcePreserved: true,
    });
    expect(fs.readFileSync(legacyPath, "utf-8")).toBe(legacyText);
    expect(fs.readFileSync(overlayPath, "utf-8")).toBe(overlayAfterFirstLoad);
    expect(first.resolution.entries.map((entry) => entry.id)).toEqual([
      "kept",
      "user-added",
    ]);
    expect(second.resolution.entries.map((entry) => entry.id)).toEqual([
      "kept",
      "new-default",
      "user-added",
    ]);
    expect(second.resolution.entries[0].controls).toEqual({
      effort: {
        persistenceKey: "brain.effort",
        allowedValues: ["low", "high"],
        defaultValue: "high",
        mappings: [
          {
            interfaceId: "claude-agent-proxy",
            target: "launch.effort-level",
            values: [
              { storedValue: "low", resolvedValue: "low" },
              { storedValue: "high", resolvedValue: "high" },
            ],
          },
        ],
      },
    });
    expect(first.resolution.entries[0].model.contextWindowSeedTokens).toBe(
      128_000
    );
    expect(second.resolution.entries[0].model.contextWindowSeedTokens).toBe(
      256_000
    );
    expect(second.resolution.disabledIds).toEqual(["removed"]);
  });

  it("treats the legacy format's formerly invalid empty array as an error, not disable-all state", () => {
    const directory = makeDirectory();
    fs.writeFileSync(
      path.join(directory, LEGACY_OLLAMA_BACKENDS_FILE),
      "[]\n",
      "utf-8"
    );

    const result = loadProviderCatalogFromDirectory(directory, [
      makeDefault("kept"),
    ]);

    expect(result.resolution.entries.map((entry) => entry.id)).toEqual([
      "kept",
    ]);
    expect(result.resolution.disabledIds).toEqual([]);
    expect(result.resolution.errors).toMatchObject([
      { code: "invalid-overlay" },
    ]);
  });

  it("reports malformed JSON without suppressing code defaults or overwriting the file", () => {
    const directory = makeDirectory();
    const overlayPath = path.join(directory, PROVIDER_CATALOG_OVERLAY_FILE);
    fs.writeFileSync(overlayPath, "{ malformed", "utf-8");

    const result = loadProviderCatalogFromDirectory(directory, [
      makeDefault("valid"),
    ]);

    expect(result.resolution.entries.map((entry) => entry.id)).toEqual([
      "valid",
    ]);
    expect(result.resolution.errors).toMatchObject([
      { code: "malformed-json" },
    ]);
    expect(() =>
      resolveProviderCatalogSnapshot(result.resolution, "valid")
    ).toThrow("Provider catalog unavailable");
    expect(fs.readFileSync(overlayPath, "utf-8")).toBe("{ malformed");
  });

  it("keeps a malformed overlay entry without a stable id entry-scoped", () => {
    const directory = makeDirectory();
    fs.writeFileSync(
      path.join(directory, PROVIDER_CATALOG_OVERLAY_FILE),
      JSON.stringify({
        schemaVersion: PROVIDER_CATALOG_SCHEMA_VERSION,
        entries: [{ id: "BAD ID", patch: { displayName: "Rejected" } }],
      }),
      "utf-8"
    );

    const result = loadProviderCatalogFromDirectory(directory, [
      makeDefault("valid"),
    ]);

    expect(result.resolution.errors).toMatchObject([
      { scope: "entry", index: 0, code: "invalid-overlay" },
    ]);
    expect(result.resolution.fatalErrors).toEqual([]);
    expect(resolveProviderCatalogSnapshot(result.resolution, "valid").id).toBe(
      "valid"
    );
  });

  it.each([
    ["unreadable overlay", "unreadable"],
    ["wrong schema version", "wrong-version"],
  ])("makes %s fatal to requested catalog routes", (_name, mode) => {
    const directory = makeDirectory();
    const overlayPath = path.join(directory, PROVIDER_CATALOG_OVERLAY_FILE);
    if (mode === "unreadable") {
      fs.mkdirSync(overlayPath);
    } else {
      fs.writeFileSync(
        overlayPath,
        JSON.stringify({ schemaVersion: 999, entries: [] }),
        "utf-8"
      );
    }

    const result = loadProviderCatalogFromDirectory(directory, [
      makeDefault("valid"),
    ]);

    expect(result.resolution.fatalErrors).toHaveLength(1);
    expect(() =>
      resolveProviderCatalogSnapshot(result.resolution, "valid")
    ).toThrow("Provider catalog unavailable");
  });

  it("persists actionable migration errors without copying raw credential values", () => {
    const directory = makeDirectory();
    const legacyPath = path.join(directory, LEGACY_OLLAMA_BACKENDS_FILE);
    fs.writeFileSync(
      legacyPath,
      JSON.stringify([
        makeLegacy("user-added"),
        { ...makeLegacy("bad"), authToken: "literal-credential-value" },
      ]),
      "utf-8"
    );

    const first = loadProviderCatalogFromDirectory(directory, [
      makeDefault("valid"),
    ]);
    const overlayText = fs.readFileSync(
      path.join(directory, PROVIDER_CATALOG_OVERLAY_FILE),
      "utf-8"
    );
    const second = loadProviderCatalogFromDirectory(directory, [
      makeDefault("valid"),
    ]);

    expect(first.resolution.errors).toMatchObject([
      { id: "bad", code: "raw-credential" },
    ]);
    expect(second.resolution.errors).toEqual(first.resolution.errors);
    expect(first.resolution.entries.map((entry) => entry.id)).toEqual([
      "valid",
      "user-added",
    ]);
    expect(overlayText).not.toContain("literal-credential-value");
  });

  it("blocks an invalid legacy built-in id without suppressing an unrelated built-in", () => {
    const directory = makeDirectory();
    fs.writeFileSync(
      path.join(directory, LEGACY_OLLAMA_BACKENDS_FILE),
      JSON.stringify([
        {
          ...makeLegacy("bad-built-in"),
          authToken: "literal-credential-value",
        },
        makeLegacy("good-built-in"),
      ]),
      "utf-8"
    );

    const result = loadProviderCatalogFromDirectory(directory, [
      makeDefault("bad-built-in"),
      makeDefault("good-built-in"),
    ]);

    expect(result.resolution.entries.map((entry) => entry.id)).toEqual([
      "good-built-in",
    ]);
    expect(result.resolution.errors).toMatchObject([
      { id: "bad-built-in", code: "raw-credential" },
    ]);
    expect(() =>
      resolveProviderCatalogSnapshot(result.resolution, "bad-built-in")
    ).toThrow("raw-credential migration error");
    expect(
      resolveProviderCatalogSnapshot(result.resolution, "good-built-in").id
    ).toBe("good-built-in");
  });

  it("keeps a malformed legacy entry without a stable id entry-scoped", () => {
    const directory = makeDirectory();
    fs.writeFileSync(
      path.join(directory, LEGACY_OLLAMA_BACKENDS_FILE),
      JSON.stringify([makeLegacy("BAD ID"), makeLegacy("good-built-in")]),
      "utf-8"
    );

    const result = loadProviderCatalogFromDirectory(directory, [
      makeDefault("good-built-in"),
      makeDefault("unrelated-built-in"),
    ]);

    expect(result.resolution.errors).toMatchObject([
      { scope: "entry", index: 0, code: "invalid-entry" },
    ]);
    expect(result.resolution.fatalErrors).toEqual([]);
    expect(result.resolution.entries.map((entry) => entry.id)).toEqual([
      "good-built-in",
      "unrelated-built-in",
    ]);
    expect(
      resolveProviderCatalogSnapshot(result.resolution, "unrelated-built-in").id
    ).toBe("unrelated-built-in");
  });
});
