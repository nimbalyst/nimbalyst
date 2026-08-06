import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PROVIDER_CATALOG_SCHEMA_VERSION,
  resolveProviderCatalogRouteSnapshot,
  resolveProviderCatalogSnapshot,
  type ProviderCatalogControlTarget,
  type ProviderCatalogEntry,
} from "../providerCatalog";
import {
  LEGACY_OLLAMA_BACKENDS_FILE,
  PROVIDER_CATALOG_OVERLAY_FILE,
  loadProviderCatalogFromDirectory,
  migrateLegacyOllamaBackends,
} from "../providerCatalogLoader";
import {
  createProviderRuntimeSessionSnapshot,
  resolveMainClaudeAgentLaunchPlan,
} from "../runtimeRouteResolver";

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

const ORDERED_CONTROL_TARGETS: readonly ProviderCatalogControlTarget[] = [
  "launch.context-window",
  "launch.effort-level",
  "interface.model-profile",
  "interface.reasoning-mode",
  "launch.thinking-mode",
];

function makeOrderedControls(count: number) {
  return Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      `control-${index}`,
      {
        persistenceKey: `fixture.control-${index}`,
        order: count - index,
        width: (["compact", "standard", "wide"] as const)[index % 3],
        displayLabel: `Control ${index}`,
        helpText: `Fixture control ${index}.`,
        valueLabels: { '"default"': `Default ${index}` },
        allowedValues: ["default"],
        defaultValue: "default",
        mappings: [
          {
            interfaceId: "claude-agent-proxy",
            target: ORDERED_CONTROL_TARGETS[index],
            values: [{ storedValue: "default", resolvedValue: "default" }],
          },
        ],
      },
    ])
  );
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("provider catalog legacy migration and loading", () => {
  it("loads a JSON-only three-mode control including an explicit omit mapping", () => {
    const directory = makeDirectory();
    const base = makeDefault("deepseek-json-fixture");
    fs.writeFileSync(
      path.join(directory, PROVIDER_CATALOG_OVERLAY_FILE),
      JSON.stringify(
        {
          schemaVersion: PROVIDER_CATALOG_SCHEMA_VERSION,
          entries: [
            {
              id: base.id,
              patch: {
                controls: {
                  reasoning: {
                    persistenceKey: "reasoning-mode",
                    order: 0,
                    width: "standard",
                    displayLabel: "Thinking effort",
                    helpText: "Reviewed profile.",
                    valueLabels: {
                      '"non-think"': "None",
                      '"think-high"': "High",
                      '"think-max"': "Max",
                    },
                    allowedValues: ["non-think", "think-high", "think-max"],
                    defaultValue: "think-high",
                    mappings: [
                      {
                        interfaceId: "claude-agent-proxy",
                        target: "request.thinking.type",
                        values: [
                          {
                            storedValue: "non-think",
                            resolvedValue: "disabled",
                          },
                          {
                            storedValue: "think-high",
                            resolvedValue: "enabled",
                          },
                          {
                            storedValue: "think-max",
                            resolvedValue: "enabled",
                          },
                        ],
                      },
                      {
                        interfaceId: "claude-agent-proxy",
                        target: "request.output-config.effort",
                        values: [
                          { storedValue: "non-think", operation: "omit" },
                          { storedValue: "think-high", resolvedValue: "high" },
                          { storedValue: "think-max", resolvedValue: "max" },
                        ],
                      },
                    ],
                  },
                },
              },
            },
          ],
        },
        null,
        2
      ),
      "utf-8"
    );

    const loaded = loadProviderCatalogFromDirectory(directory, [base]);
    const snapshot = resolveProviderCatalogRouteSnapshot(
      loaded.resolution,
      base.id,
      { "reasoning-mode": "non-think" }
    );
    expect(snapshot.entry.controls.reasoning.allowedValues).toEqual([
      "non-think",
      "think-high",
      "think-max",
    ]);
    expect(snapshot.mappings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: "request.thinking.type",
          value: "disabled",
        }),
        expect.objectContaining({
          target: "request.output-config.effort",
          operation: "omit",
        }),
      ])
    );
    const runtimeSnapshot = createProviderRuntimeSessionSnapshot(
      resolveMainClaudeAgentLaunchPlan(loaded.resolution, {
        catalogEntryId: base.id,
        persistedModelId: base.model.persistedId,
        persistedControls: { "reasoning-mode": "non-think" },
        credentialReferences: { "nimbalyst.local-proxy": true },
      })
    );
    expect(runtimeSnapshot.receipt.requested.controls).toEqual({
      reasoning: "non-think",
    });
    expect(runtimeSnapshot.receipt.resolvedControls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: "request.thinking.type",
          operation: "set",
          value: "disabled",
        }),
        expect.objectContaining({
          target: "request.output-config.effort",
          operation: "omit",
        }),
      ])
    );
  });

  it.each([0, 3, 4])(
    "loads a JSON-only fixture with %i ordered model controls",
    (count) => {
      const directory = makeDirectory();
      const base = makeDefault(`ordered-${count}`);
      fs.writeFileSync(
        path.join(directory, PROVIDER_CATALOG_OVERLAY_FILE),
        JSON.stringify({
          schemaVersion: PROVIDER_CATALOG_SCHEMA_VERSION,
          entries: [
            { id: base.id, patch: { controls: makeOrderedControls(count) } },
          ],
        }),
        "utf-8"
      );

      const loaded = loadProviderCatalogFromDirectory(directory, [base]);
      expect(loaded.resolution.errors).toEqual([]);
      const snapshot = resolveProviderCatalogSnapshot(
        loaded.resolution,
        base.id
      );
      expect(
        Object.values(snapshot.controls).map((control) => ({
          order: control.order,
          label: control.displayLabel,
          width: control.width,
          values: control.allowedValues,
          defaultValue: control.defaultValue,
        }))
      ).toEqual(
        Array.from({ length: count }, (_, offset) => {
          const index = count - offset - 1;
          return {
            order: offset + 1,
            label: `Control ${index}`,
            width: (["compact", "standard", "wide"] as const)[index % 3],
            values: ["default"],
            defaultValue: "default",
          };
        })
      );
    }
  );

  it("fails a JSON-only fifth model control with a clear catalog error", () => {
    const directory = makeDirectory();
    const base = makeDefault("ordered-five");
    fs.writeFileSync(
      path.join(directory, PROVIDER_CATALOG_OVERLAY_FILE),
      JSON.stringify({
        schemaVersion: PROVIDER_CATALOG_SCHEMA_VERSION,
        entries: [{ id: base.id, patch: { controls: makeOrderedControls(5) } }],
      }),
      "utf-8"
    );

    const loaded = loadProviderCatalogFromDirectory(directory, [base]);
    expect(loaded.resolution.entries).toEqual([]);
    expect(loaded.resolution.errors).toEqual([
      expect.objectContaining({
        code: "invalid-controls",
        message: expect.stringContaining("at most four model-owned controls"),
      }),
    ]);
  });

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
        order: 0,
        width: "standard",
        applicability: {
          launch: true,
          restart: true,
          midSession: true,
        },
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
        order: 0,
        width: "standard",
        applicability: {
          launch: true,
          restart: true,
          midSession: true,
        },
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
