import { describe, expect, it } from "vitest";
import {
  PROVIDER_CATALOG_SCHEMA_VERSION,
  compareProviderCatalogEntries,
  exportNormalizedProviderCatalog,
  getProviderCatalogLeafLabel,
  resolveProviderCatalog,
  resolveProviderCatalogRouteSnapshot,
  resolveProviderCatalogSnapshot,
  serializeNormalizedProviderCatalog,
  type ProviderCatalogEntry,
} from "../providerCatalog";
import { MAX_CONTEXT_WINDOW_SEED_TOKENS } from "../../../../contextMeter";
import {
  BUILT_IN_PROVIDER_CATALOG,
  CLAUDEX_LUNA_ENTRY_ID,
  CLAUDEX_SOL_ENTRY_ID,
  CLAUDEX_TERRA_ENTRY_ID,
  DEEPSEEK_V4_FLASH_OFFICIAL_ENTRY_ID,
  DEEPSEEK_V4_FLASH_OPENROUTER_ENTRY_ID,
  DEEPSEEK_V4_PRO_OFFICIAL_ENTRY_ID,
  DEEPSEEK_V4_PRO_OPENROUTER_ENTRY_ID,
  OLLAMA_DEEPSEEK_V4_FLASH_0731_ENTRY_ID,
} from "../providerCatalogDefaults";

function makeEntry(
  id: string,
  overrides: Partial<ProviderCatalogEntry> = {}
): ProviderCatalogEntry {
  return {
    id,
    provider: "ollama",
    harness: { id: "claude-agent", order: 10 },
    family: { id: "test-family", order: 10 },
    displayName: `Test ${id}`,
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
    ...overrides,
  };
}

function makePatch(id: string) {
  const { id: _id, ...patch } = makeEntry(id);
  return patch;
}

describe("provider catalog schema and merge", () => {
  it("pins reviewed per-model seeds and per-interface telemetry for every admitted route", () => {
    const byId = new Map(
      BUILT_IN_PROVIDER_CATALOG.map((entry) => [entry.id, entry])
    );
    const expectedSeeds = new Map<string, number>([
      [CLAUDEX_SOL_ENTRY_ID, 372_000],
      [CLAUDEX_TERRA_ENTRY_ID, 372_000],
      [CLAUDEX_LUNA_ENTRY_ID, 372_000],
      [DEEPSEEK_V4_PRO_OFFICIAL_ENTRY_ID, 1_000_000],
      [DEEPSEEK_V4_FLASH_OFFICIAL_ENTRY_ID, 128_000],
      [DEEPSEEK_V4_PRO_OPENROUTER_ENTRY_ID, 1_000_000],
      [DEEPSEEK_V4_FLASH_OPENROUTER_ENTRY_ID, 128_000],
    ]);

    for (const [id, seed] of expectedSeeds) {
      const entry = byId.get(id);
      expect(entry?.model.contextWindowSeedTokens, id).toBe(seed);
      expect(entry?.interfaces[0].contextTelemetry, id).toEqual({
        adapterId: "claude-agent-sdk-parent-v1",
        windowPolicy: "runtime-then-model-seed",
      });
    }

    for (const providerModelId of [
      "deepseek-v4-pro:cloud",
      "deepseek-v4-flash:cloud",
      "glm-5.2:cloud",
    ]) {
      const entry = BUILT_IN_PROVIDER_CATALOG.find(
        (candidate) => candidate.model.providerModelId === providerModelId
      );
      expect(entry?.model.contextWindowSeedTokens, providerModelId).toBe(
        providerModelId.includes("deepseek-v4-pro") ? 1_000_000 : 128_000
      );
      expect(entry?.interfaces[0].contextTelemetry, providerModelId).toEqual({
        adapterId: "claude-agent-sdk-parent-v1",
        windowPolicy: "runtime-then-model-seed",
      });
    }
  });

  it("keeps DeepSeek reasoning controls provider-scoped instead of inheriting unverified routes", () => {
    const byId = new Map(
      BUILT_IN_PROVIDER_CATALOG.map((entry) => [entry.id, entry])
    );
    const official = byId.get(DEEPSEEK_V4_PRO_OFFICIAL_ENTRY_ID)!;
    expect(official.controls.reasoning).toMatchObject({
      persistenceKey: "reasoning-mode",
      allowedValues: ["non-think", "think-high", "think-max"],
      defaultValue: "think-high",
    });
    expect(byId.get(DEEPSEEK_V4_PRO_OPENROUTER_ENTRY_ID)?.controls).toEqual({});
    expect(
      BUILT_IN_PROVIDER_CATALOG.find(
        (entry) => entry.model.providerModelId === "deepseek-v4-pro:cloud"
      )?.controls
    ).toEqual({});
  });

  it("admits the dated Ollama Flash 0731 identity without inheriting preview metadata or controls", () => {
    const resolution = resolveProviderCatalog(
      BUILT_IN_PROVIDER_CATALOG,
      undefined
    );
    const dated = resolveProviderCatalogSnapshot(
      resolution,
      OLLAMA_DEEPSEEK_V4_FLASH_0731_ENTRY_ID
    );
    const preview = BUILT_IN_PROVIDER_CATALOG.find(
      (entry) => entry.model.providerModelId === "deepseek-v4-flash:cloud"
    );

    expect(dated).toMatchObject({
      id: OLLAMA_DEEPSEEK_V4_FLASH_0731_ENTRY_ID,
      provider: "ollama",
      displayName: "DeepSeek V4 Flash 0731",
      admission: {
        state: "high-runner-candidate",
        reasonCode: "proxy-alias-unqualified",
      },
      model: {
        persistedId: "claude-code:ollama-deepseek-v4-flash-0731",
        providerModelId: "deepseek-v4-flash:0731",
        version: "deepseek-v4-flash:0731",
      },
      controls: {},
      capabilities: {
        mainSession: false,
        subagent: false,
        consultation: false,
        tools: false,
        vision: false,
      },
      interfaces: [],
    });
    expect(dated.model.contextWindowSeedTokens).toBeUndefined();
    expect(dated.model.persistedId).not.toBe(preview?.model.persistedId);
    expect(dated.model.providerModelId).not.toBe(
      preview?.model.providerModelId
    );
  });

  it.each([
    ["zero seed", { model: { contextWindowSeedTokens: 0 } }],
    [
      "over-bound seed",
      {
        model: { contextWindowSeedTokens: MAX_CONTEXT_WINDOW_SEED_TOKENS + 1 },
      },
    ],
    [
      "unknown telemetry adapter",
      {
        interfaces: [
          {
            ...makeEntry("bad-adapter").interfaces[0],
            contextTelemetry: {
              adapterId: "runtime-jsonpath" as never,
              windowPolicy: "runtime-then-model-seed" as const,
            },
          },
        ],
      },
    ],
    [
      "unknown window policy",
      {
        interfaces: [
          {
            ...makeEntry("bad-policy").interfaces[0],
            contextTelemetry: {
              adapterId: "claude-agent-sdk-parent-v1" as const,
              windowPolicy: "catalog-is-exact" as never,
            },
          },
        ],
      },
    ],
  ])("rejects unsafe inert context configuration: %s", (_label, patch) => {
    const entry = makeEntry("bad-context");
    const resolution = resolveProviderCatalog([entry], {
      schemaVersion: PROVIDER_CATALOG_SCHEMA_VERSION,
      entries: [{ id: entry.id, patch }],
    });
    expect(resolution.entries).toEqual([]);
    expect(resolution.errors[0]?.code).toMatch(
      /invalid-entry|adapter-required/
    );
  });

  it("merges overrides, disables, additions, and newly shipped defaults by stable id", () => {
    const firstDefault = makeEntry("first");
    const disabledDefault = makeEntry("disabled");
    const newDefault = makeEntry("new-after-upgrade");
    const overlay = {
      schemaVersion: PROVIDER_CATALOG_SCHEMA_VERSION,
      entries: [
        { id: "first", patch: { displayName: "User override" } },
        { id: "disabled", disabled: true },
        { id: "user-added", patch: makePatch("user-added") },
      ],
    };

    const resolution = resolveProviderCatalog(
      [firstDefault, disabledDefault, newDefault],
      overlay
    );

    expect(resolution.entries.map((entry) => entry.id)).toEqual([
      "new-after-upgrade",
      "user-added",
      "first",
    ]);
    expect(
      resolution.entries.find((entry) => entry.id === "first")?.displayName
    ).toBe("User override");
    expect(resolution.disabledIds).toEqual(["disabled"]);
    expect(resolution.errors).toEqual([]);
    expect(firstDefault.displayName).toBe("Test first");
  });

  it("blocks duplicate overlay ids without falling back to the built-in entry", () => {
    const resolution = resolveProviderCatalog([makeEntry("duplicate")], {
      schemaVersion: PROVIDER_CATALOG_SCHEMA_VERSION,
      entries: [
        { id: "duplicate", patch: { displayName: "First override" } },
        { id: "duplicate", patch: { displayName: "Second override" } },
      ],
    });

    expect(resolution.entries).toEqual([]);
    expect(resolution.errors).toMatchObject([
      { id: "duplicate", code: "duplicate-id" },
    ]);
    expect(() =>
      resolveProviderCatalogSnapshot(resolution, "duplicate")
    ).toThrow("duplicate overlay entries");
  });

  it.each([
    [
      "raw credentials",
      { authToken: "literal-credential-value" },
      "raw-credential",
    ],
    ["arbitrary commands", { command: "provider-cli" }, "arbitrary-command"],
    [
      "unsafe endpoints",
      {
        interfaces: [
          { ...makeEntry("bad").interfaces[0], endpoint: "http://example.com" },
        ],
      },
      "unsafe-endpoint",
    ],
    [
      "unsupported interfaces",
      { interfaces: [{ ...makeEntry("bad").interfaces[0], kind: "stdio" }] },
      "unsupported-interface",
    ],
    [
      "unsupported transport profiles",
      {
        interfaces: [
          {
            ...makeEntry("bad").interfaces[0],
            transportProfile: "shell-command",
          },
        ],
      },
      "unsupported-transport-profile",
    ],
    [
      "new protocols",
      {
        interfaces: [
          { ...makeEntry("bad").interfaces[0], protocol: "future-protocol" },
        ],
      },
      "adapter-required",
    ],
    [
      "new auth schemes",
      {
        interfaces: [
          { ...makeEntry("bad").interfaces[0], authProfile: "future-auth" },
        ],
      },
      "adapter-required",
    ],
    [
      "invalid control defaults",
      {
        controls: {
          effort: {
            persistenceKey: "brain.effort",
            allowedValues: ["low", "high"],
            defaultValue: "max",
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
        },
      },
      "invalid-controls",
    ],
    [
      "malformed capabilities",
      { capabilities: { ...makeEntry("bad").capabilities, tools: "yes" } },
      "malformed-capabilities",
    ],
    [
      "capabilities that disagree with reviewed interfaces",
      {
        capabilities: { ...makeEntry("bad").capabilities, mainSession: false },
      },
      "malformed-capabilities",
    ],
  ])(
    "fails closed for %s while preserving unrelated valid entries",
    (_name, patch, code) => {
      const resolution = resolveProviderCatalog(
        [makeEntry("bad"), makeEntry("good")],
        {
          schemaVersion: PROVIDER_CATALOG_SCHEMA_VERSION,
          entries: [{ id: "bad", patch: patch as never }],
        }
      );

      expect(resolution.entries.map((entry) => entry.id)).toEqual(["good"]);
      expect(resolution.errors).toMatchObject([{ id: "bad", code }]);
      expect(() => resolveProviderCatalogSnapshot(resolution, "bad")).toThrow();
    }
  );

  it("rejects a credential literal placed in a credential reference field", () => {
    const entry = makeEntry("bad-ref");
    const resolution = resolveProviderCatalog([entry], {
      schemaVersion: PROVIDER_CATALOG_SCHEMA_VERSION,
      entries: [
        {
          id: entry.id,
          patch: {
            interfaces: [
              {
                ...entry.interfaces[0],
                credentialRef: "literal-credential-value",
              },
            ],
          },
        },
      ],
    });

    expect(resolution.errors).toMatchObject([
      { id: "bad-ref", code: "raw-credential" },
    ]);
  });

  it.each([
    ["dotted secret-like literal", "sk.live-secret-material", "raw-credential"],
    ["unknown reference", "nimbalyst.unknown-ref", "adapter-required"],
  ])("rejects %s as a credential reference", (_name, credentialRef, code) => {
    const entry = makeEntry("bad-credential-ref");
    const resolution = resolveProviderCatalog([entry], {
      schemaVersion: PROVIDER_CATALOG_SCHEMA_VERSION,
      entries: [
        {
          id: entry.id,
          patch: {
            interfaces: [{ ...entry.interfaces[0], credentialRef }],
          },
        },
      ],
    });

    expect(resolution.entries).toEqual([]);
    expect(resolution.errors).toMatchObject([
      { scope: "entry", id: entry.id, code },
    ]);
  });

  it("does not let an overlay reassign a built-in identity owner", () => {
    const resolution = resolveProviderCatalog([makeEntry("owned")], {
      schemaVersion: PROVIDER_CATALOG_SCHEMA_VERSION,
      entries: [
        {
          id: "owned",
          patch: {
            provider: "claudex",
            harness: { id: "codex" },
            model: {
              persistedId: "claude-code:claudex-owned",
              persistedIdNamespace: "claude-code:claudex-",
            },
          },
        },
      ],
    });

    expect(resolution.entries).toEqual([]);
    expect(resolution.errors).toMatchObject([
      { id: "owned", code: "invalid-overlay" },
    ]);
  });

  it("does not let an overlay repoint a built-in exact persisted identity within its namespace", () => {
    const resolution = resolveProviderCatalog([makeEntry("owned")], {
      schemaVersion: PROVIDER_CATALOG_SCHEMA_VERSION,
      entries: [
        {
          id: "owned",
          patch: {
            model: { persistedId: "claude-code:ollama-repointed" },
          },
        },
      ],
    });

    expect(resolution.entries).toEqual([]);
    expect(resolution.errors).toMatchObject([
      { scope: "entry", id: "owned", code: "invalid-overlay" },
    ]);
  });

  it("keeps invalid-id overlay entries entry-scoped instead of suppressing unrelated routes", () => {
    const resolution = resolveProviderCatalog([makeEntry("valid")], {
      schemaVersion: PROVIDER_CATALOG_SCHEMA_VERSION,
      entries: [{ id: "BAD ID", patch: { displayName: "Rejected" } }],
    });

    expect(resolution.errors).toMatchObject([
      { scope: "entry", index: 0, code: "invalid-overlay" },
    ]);
    expect(resolution.fatalErrors).toEqual([]);
    expect(resolveProviderCatalogSnapshot(resolution, "valid").id).toBe(
      "valid"
    );
  });

  it.each([
    ["endpoint query", "endpoint", "https://example.com/v1?token=secret"],
    ["endpoint fragment", "endpoint", "https://example.com/v1#secret"],
    ["endpoint userinfo", "endpoint", "https://user:pass@example.com/v1"],
    [
      "endpoint encoded userinfo",
      "endpoint",
      "https://user%3Apass@example.com/v1",
    ],
    ["upstream query", "upstreamEndpoint", "https://example.com/v1?key=secret"],
    ["upstream fragment", "upstreamEndpoint", "https://example.com/v1#secret"],
  ])("rejects %s", (_name, field, value) => {
    const bad = makeEntry("endpoint-seam");
    const resolution = resolveProviderCatalog([bad], {
      schemaVersion: PROVIDER_CATALOG_SCHEMA_VERSION,
      entries: [
        {
          id: bad.id,
          patch: {
            interfaces: [{ ...bad.interfaces[0], [field]: value }],
          },
        },
      ],
    });

    expect(resolution.entries).toEqual([]);
    expect(resolution.errors).toMatchObject([
      { id: "endpoint-seam", code: "unsafe-endpoint" },
    ]);
  });

  it.each(
    ["endpoint", "upstreamEndpoint"].flatMap((field) => [
      [
        `${field} direct secret path`,
        field,
        "https://example.com/v1/sk-placeholder-material",
      ],
      [
        `${field} raw dot-segment erasure`,
        field,
        "https://example.com/v1/sk-placeholder-material/..",
      ],
      [
        `${field} case-varied encoded dot-segment erasure`,
        field,
        "https://example.com/v1/SK-PLACEHOLDER-MATERIAL/%2e%2e",
      ],
      [
        `${field} repeatedly encoded dot-segment erasure`,
        field,
        "https://example.com/v1/sk-placeholder-material/%25252e%25252e",
      ],
      [
        `${field} encoded separator obfuscation`,
        field,
        "https://example.com/v1%2fsk%2dplaceholder%2dmaterial%2f..",
      ],
      [
        `${field} raw backslash separator obfuscation`,
        field,
        String.raw`https://example.com/v1\sk-placeholder-material\..`,
      ],
      [
        `${field} encoded backslash separator obfuscation`,
        field,
        "https://example.com/v1/%5csk%2dplaceholder%2dmaterial%5c..",
      ],
      [
        `${field} double-encoded secret segment`,
        field,
        "https://example.com/v1/%2573%256b%252dplaceholder%252dmaterial",
      ],
    ])
  )(
    "rejects %s before snapshots or normalized exports",
    (_name, field, value) => {
      const rejected = makeEntry("path-credential");
      const safe = makeEntry("safe-route");
      const resolution = resolveProviderCatalog([rejected, safe], {
        schemaVersion: PROVIDER_CATALOG_SCHEMA_VERSION,
        entries: [
          {
            id: rejected.id,
            patch: {
              interfaces: [{ ...rejected.interfaces[0], [field]: value }],
            },
          },
        ],
      });

      expect(resolution.entries.map((entry) => entry.id)).toEqual([safe.id]);
      expect(resolution.errors).toMatchObject([
        { scope: "entry", id: rejected.id, code: "unsafe-endpoint" },
      ]);
      expect(() =>
        resolveProviderCatalogSnapshot(resolution, rejected.id)
      ).toThrow("reviewed credential-free proxy base path");
      expect(
        exportNormalizedProviderCatalog(resolution).entries.map(
          (entry) => entry.id
        )
      ).toEqual([safe.id]);
    }
  );

  it.each(["/", "/v1", "/api/v1", "/openai/v1", "/anthropic/v1/"])(
    "preserves reviewed legitimate proxy base path %s",
    (pathname) => {
      const entry = makeEntry("reviewed-path");
      const resolution = resolveProviderCatalog([entry], {
        schemaVersion: PROVIDER_CATALOG_SCHEMA_VERSION,
        entries: [
          {
            id: entry.id,
            patch: {
              interfaces: [
                {
                  ...entry.interfaces[0],
                  endpoint: `https://proxy.example${pathname}`,
                  upstreamEndpoint: `https://upstream.example${pathname}`,
                },
              ],
            },
          },
        ],
      });

      expect(resolution.errors).toEqual([]);
      expect(resolveProviderCatalogSnapshot(resolution, entry.id).id).toBe(
        entry.id
      );
    }
  );

  it.each(["claude-code:sonnet", "openai-codex:gpt-5.6-sol"])(
    "rejects reserved persisted identity %s",
    (persistedId) => {
      const resolution = resolveProviderCatalog([makeEntry("reserved")], {
        schemaVersion: PROVIDER_CATALOG_SCHEMA_VERSION,
        entries: [
          {
            id: "reserved",
            patch: { model: { persistedId } },
          },
        ],
      });

      expect(resolution.entries).toEqual([]);
      expect(resolution.errors).toMatchObject([
        { id: "reserved", code: "invalid-overlay" },
      ]);
    }
  );

  it.each([
    ["a-main", "z-main"],
    ["renamed-one", "renamed-two"],
  ])(
    "rejects ambiguous consumer ownership regardless of interface ids",
    (firstId, secondId) => {
      const entry = makeEntry("ambiguous");
      const first = { ...entry.interfaces[0], id: firstId };
      const second = { ...entry.interfaces[0], id: secondId };
      for (const interfaces of [
        [first, second],
        [second, first],
      ]) {
        const resolution = resolveProviderCatalog([entry], {
          schemaVersion: PROVIDER_CATALOG_SCHEMA_VERSION,
          entries: [{ id: entry.id, patch: { interfaces } }],
        });
        expect(resolution.entries).toEqual([]);
        expect(resolution.errors).toMatchObject([
          { id: entry.id, code: "ambiguous-interface" },
        ]);
      }
    }
  );

  it("blocks the errored id from an external migration while preserving unrelated entries", () => {
    const resolution = resolveProviderCatalog(
      [makeEntry("bad"), makeEntry("good")],
      undefined,
      [
        {
          scope: "entry",
          id: "bad",
          code: "raw-credential",
          message: "sanitized migration error",
        },
      ]
    );

    expect(resolution.entries.map((entry) => entry.id)).toEqual(["good"]);
    expect(() => resolveProviderCatalogSnapshot(resolution, "bad")).toThrow(
      "sanitized migration error"
    );
  });

  it("treats global source errors as fatal to catalog snapshots", () => {
    const resolution = resolveProviderCatalog(
      [makeEntry("built-in")],
      undefined,
      [
        {
          scope: "source",
          code: "malformed-json",
          message: "Overlay JSON is malformed.",
        },
      ]
    );

    expect(resolution.entries.map((entry) => entry.id)).toEqual(["built-in"]);
    expect(resolution.fatalErrors).toMatchObject([
      { scope: "source", code: "malformed-json" },
    ]);
    expect(() =>
      resolveProviderCatalogSnapshot(resolution, "built-in")
    ).toThrow("Provider catalog unavailable");
    expect(() => exportNormalizedProviderCatalog(resolution)).toThrow(
      "Provider catalog unavailable"
    );
  });

  it("resolves stored controls through reviewed mappings into an immutable route snapshot", () => {
    const entry = makeEntry("controlled", {
      controls: {
        effort: {
          persistenceKey: "brain.effort",
          allowedValues: ["low", "high"],
          defaultValue: "low",
          mappings: [
            {
              interfaceId: "claude-agent-proxy",
              target: "launch.effort-level",
              values: [
                { storedValue: "low", resolvedValue: "low" },
                { storedValue: "high", resolvedValue: "max" },
              ],
            },
          ],
        },
      },
    });
    const resolution = resolveProviderCatalog([entry], undefined);
    const snapshot = resolveProviderCatalogRouteSnapshot(resolution, entry.id, {
      "brain.effort": "high",
    });

    expect(snapshot.controlValues).toEqual({ effort: "high" });
    expect(snapshot.mappings).toEqual([
      {
        controlId: "effort",
        persistenceKey: "brain.effort",
        interfaceId: "claude-agent-proxy",
        target: "launch.effort-level",
        operation: "set",
        value: "max",
      },
    ]);
    expect(
      new Set(
        snapshot.mappings.map(
          (mapping) => `${mapping.interfaceId}:${mapping.target}`
        )
      ).size
    ).toBe(snapshot.mappings.length);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.mappings)).toBe(true);
    expect(() =>
      resolveProviderCatalogRouteSnapshot(resolution, entry.id, {
        "brain.effort": "max",
      })
    ).toThrow("unsupported persisted value");
  });

  it("resolves an explicit reviewed omit without inventing a sentinel value", () => {
    const entry = makeEntry("controlled-omit", {
      controls: {
        reasoning: {
          persistenceKey: "reasoning-mode",
          allowedValues: ["non-think", "think-high"],
          defaultValue: "think-high",
          mappings: [
            {
              interfaceId: "claude-agent-proxy",
              target: "request.output-config.effort",
              values: [
                { storedValue: "non-think", operation: "omit" },
                { storedValue: "think-high", resolvedValue: "high" },
              ],
            },
          ],
        },
      },
    });
    const resolution = resolveProviderCatalog([entry], undefined);

    expect(
      resolveProviderCatalogRouteSnapshot(resolution, entry.id, {
        "reasoning-mode": "non-think",
      }).mappings
    ).toEqual([
      expect.objectContaining({
        target: "request.output-config.effort",
        operation: "omit",
      }),
    ]);
  });

  it.each([
    { storedValue: "on" },
    { storedValue: "on", resolvedValue: "high", operation: "omit" },
    { storedValue: "on", operation: "drop" },
  ])(
    "rejects ambiguous or unsupported mapping operations: %j",
    (mappedValue) => {
      const entry = makeEntry("bad-mapping-operation");
      const resolution = resolveProviderCatalog([entry], {
        schemaVersion: PROVIDER_CATALOG_SCHEMA_VERSION,
        entries: [
          {
            id: entry.id,
            patch: {
              controls: {
                reasoning: {
                  persistenceKey: "reasoning-mode",
                  allowedValues: ["on"],
                  defaultValue: "on",
                  mappings: [
                    {
                      interfaceId: "claude-agent-proxy",
                      target: "request.output-config.effort",
                      values: [mappedValue as never],
                    },
                  ],
                },
              },
            },
          },
        ],
      });
      expect(resolution.entries).toEqual([]);
      expect(resolution.errors).toMatchObject([{ code: "invalid-controls" }]);
    }
  );

  it("rejects unreviewed control mapping targets", () => {
    const entry = makeEntry("bad-control-target");
    const resolution = resolveProviderCatalog([entry], {
      schemaVersion: PROVIDER_CATALOG_SCHEMA_VERSION,
      entries: [
        {
          id: entry.id,
          patch: {
            controls: {
              effort: {
                persistenceKey: "brain.effort",
                allowedValues: ["low"],
                defaultValue: "low",
                mappings: [
                  {
                    interfaceId: "claude-agent-proxy",
                    target: "environment.arbitrary" as never,
                    values: [{ storedValue: "low", resolvedValue: "secret" }],
                  },
                ],
              },
            },
          },
        },
      ],
    });

    expect(resolution.entries).toEqual([]);
    expect(resolution.errors).toMatchObject([
      { id: entry.id, code: "invalid-controls" },
    ]);
  });

  it.each([
    [
      "effort set/set",
      "launch.effort-level",
      "request.output-config.effort",
      "low",
      { storedValue: "on", resolvedValue: "max" },
    ],
    [
      "effort set/omit",
      "launch.effort-level",
      "request.output-config.effort",
      "low",
      { storedValue: "on", operation: "omit" },
    ],
    [
      "thinking set/set",
      "launch.thinking-mode",
      "request.thinking.type",
      "disabled",
      { storedValue: "on", resolvedValue: "enabled" },
    ],
  ] as const)(
    "rejects canonical alias ownership collisions (%s)",
    (_label, firstTarget, secondTarget, firstResolvedValue, secondValue) => {
      const entry = makeEntry("duplicate-control-target");
      const resolution = resolveProviderCatalog([entry], {
        schemaVersion: PROVIDER_CATALOG_SCHEMA_VERSION,
        entries: [
          {
            id: entry.id,
            patch: {
              controls: {
                first: {
                  persistenceKey: "brain.first",
                  allowedValues: ["on"],
                  defaultValue: "on",
                  mappings: [
                    {
                      interfaceId: "claude-agent-proxy",
                      target: firstTarget,
                      values: [
                        {
                          storedValue: "on",
                          resolvedValue: firstResolvedValue,
                        },
                      ],
                    },
                  ],
                },
                second: {
                  persistenceKey: "brain.second",
                  allowedValues: ["on"],
                  defaultValue: "on",
                  mappings: [
                    {
                      interfaceId: "claude-agent-proxy",
                      target: secondTarget,
                      values: [secondValue],
                    },
                  ],
                },
              },
            },
          },
        ],
      });

      expect(resolution.entries).toEqual([]);
      expect(resolution.errors).toMatchObject([
        { scope: "entry", id: entry.id, code: "invalid-controls" },
      ]);
    }
  );

  it("encodes canonical harness, family, model, and provider leaf order", () => {
    const families = [
      ["native", 10],
      ["deepseek", 20],
      ["qwen", 30],
      ["kimi", 40],
      ["glm", 50],
      ["minimax", 60],
      ["codex", 70],
      ["grok", 80],
    ] as const;
    const entries = families
      .map(([family, order]) =>
        makeEntry(`order-${family}`, {
          family: { id: family, order },
          displayName: family.toUpperCase(),
        })
      )
      .reverse();
    const sorted = [...entries].sort(compareProviderCatalogEntries);

    expect(sorted.map((entry) => entry.family.id)).toEqual(
      families.map(([family]) => family)
    );
    expect(getProviderCatalogLeafLabel(sorted[1])).toBe("DEEPSEEK (ollama)");
  });

  it("orders same-family entries by model leaf even when unauthorized numeric order conflicts", () => {
    const alpha = makeEntry("alpha", { displayName: "Alpha" });
    const zeta = makeEntry("zeta", { displayName: "Zeta" });
    (
      alpha.model as ProviderCatalogEntry["model"] & { order: number }
    ).order = 99;
    (zeta.model as ProviderCatalogEntry["model"] & { order: number }).order = 0;

    expect(
      [zeta, alpha].sort(compareProviderCatalogEntries).map((entry) => entry.id)
    ).toEqual(["alpha", "zeta"]);

    const resolution = resolveProviderCatalog([makeEntry("no-model-order")], {
      schemaVersion: PROVIDER_CATALOG_SCHEMA_VERSION,
      entries: [
        {
          id: "no-model-order",
          patch: { model: { order: 0 } as never },
        },
      ],
    });
    expect(resolution.entries).toEqual([]);
    expect(resolution.errors).toMatchObject([
      { scope: "entry", id: "no-model-order", code: "invalid-entry" },
    ]);
  });

  it("rejects duplicate persisted model identities without suppressing the existing entry", () => {
    const existing = makeEntry("existing");
    const duplicatePatch = makePatch("duplicate-model");
    duplicatePatch.model = {
      ...duplicatePatch.model!,
      persistedId: existing.model.persistedId,
    };

    const resolution = resolveProviderCatalog([existing], {
      schemaVersion: PROVIDER_CATALOG_SCHEMA_VERSION,
      entries: [{ id: "duplicate-model", patch: duplicatePatch }],
    });

    expect(resolution.entries.map((entry) => entry.id)).toEqual(["existing"]);
    expect(resolution.errors).toMatchObject([
      { id: "duplicate-model", code: "duplicate-id" },
    ]);
  });

  it("returns immutable snapshots insulated from later overlay mutation", () => {
    const patch = { displayName: "Snapshot name" };
    const resolution = resolveProviderCatalog([makeEntry("snapshot")], {
      schemaVersion: PROVIDER_CATALOG_SCHEMA_VERSION,
      entries: [{ id: "snapshot", patch }],
    });
    const snapshot = resolveProviderCatalogSnapshot(resolution, "snapshot");

    patch.displayName = "Changed later";
    expect(snapshot.displayName).toBe("Snapshot name");
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.interfaces)).toBe(true);
    expect(Object.isFrozen(snapshot.interfaces[0])).toBe(true);
    expect(() => {
      (snapshot as { displayName: string }).displayName = "Mutation attempt";
    }).toThrow();
  });

  it("freezes seed and telemetry for an active route while a new resolution sees overlay changes", () => {
    const base = makeEntry("meter-route");
    const firstResolution = resolveProviderCatalog([base], undefined);
    const active = resolveProviderCatalogRouteSnapshot(
      firstResolution,
      base.id
    );
    const secondResolution = resolveProviderCatalog([base], {
      schemaVersion: PROVIDER_CATALOG_SCHEMA_VERSION,
      entries: [
        {
          id: base.id,
          patch: { model: { contextWindowSeedTokens: 256_000 } },
        },
      ],
    });
    const nextSession = resolveProviderCatalogRouteSnapshot(
      secondResolution,
      base.id
    );

    expect(active.entry.model.contextWindowSeedTokens).toBe(128_000);
    expect(active.entry.interfaces[0].contextTelemetry).toEqual({
      adapterId: "claude-agent-sdk-parent-v1",
      windowPolicy: "runtime-then-model-seed",
    });
    expect(nextSession.entry.model.contextWindowSeedTokens).toBe(256_000);
    expect(Object.isFrozen(active.entry.model)).toBe(true);
    expect(Object.isFrozen(active.entry.interfaces[0].contextTelemetry)).toBe(
      true
    );
  });

  it("exports deterministic normalized objects and JSON", () => {
    const resolution = resolveProviderCatalog(
      [makeEntry("z-last"), makeEntry("a-first")],
      undefined
    );
    const normalized = exportNormalizedProviderCatalog(resolution);

    expect(normalized.schemaVersion).toBe(PROVIDER_CATALOG_SCHEMA_VERSION);
    expect(normalized.entries.map((entry) => entry.id)).toEqual([
      "a-first",
      "z-last",
    ]);
    expect(serializeNormalizedProviderCatalog(resolution)).toBe(
      `${JSON.stringify(normalized, null, 2)}\n`
    );
  });
});
