import { describe, expect, it } from "vitest";
import {
  resolveProviderCatalog,
  type ProviderCatalogEntry,
  type ProviderCatalogOverlay,
  type ProviderCatalogResolution,
} from "@nimbalyst/runtime/ai/server/providers/claudeCode/providerCatalog";
import { BUILT_IN_PROVIDER_CATALOG } from "@nimbalyst/runtime/ai/server/providers/claudeCode/providerCatalogDefaults";
import { mergeProviderCatalogPickerModels } from "../providerCatalogPicker";

const credentialPresent = () => true;

describe("provider catalog picker projection", () => {
  it("keeps native rows first and deterministically orders every catalog family and provider variant", () => {
    const native = [
      {
        id: "claude-code:opus",
        name: "Claude Agent · Opus",
        provider: "claude-code" as const,
        maxTokens: 8192,
      },
      {
        id: "claude-code:haiku",
        name: "Claude Agent · Haiku",
        provider: "claude-code" as const,
        maxTokens: 8192,
      },
      {
        id: "claude-code:deepseek-v4-pro",
        name: "Legacy DeepSeek alias",
        provider: "claude-code" as const,
        maxTokens: 8192,
      },
    ];
    const shuffled = [...BUILT_IN_PROVIDER_CATALOG].reverse();
    const rows = mergeProviderCatalogPickerModels(
      native,
      resolveProviderCatalog(shuffled, undefined),
      shuffled,
      credentialPresent
    );

    expect(rows.slice(0, 2).map(({ id }) => id)).toEqual([
      "claude-code:opus",
      "claude-code:haiku",
    ]);
    expect(rows.slice(2).map(({ id }) => id)).toEqual([
      "claude-code:deepseek-v4-flash",
      "claude-code:ollama-deepseek-v4-flash-cloud",
      "claude-code:openrouter-deepseek-v4-flash",
      "claude-code:ollama-deepseek-v4-flash-0731",
      "claude-code:deepseek-v4-pro",
      "claude-code:ollama-deepseek-v4-pro-cloud",
      "claude-code:openrouter-deepseek-v4-pro",
      "claude-code:ollama-qwen3-5-cloud",
      "claude-code:ollama-kimi-k2-6-cloud",
      "claude-code:ollama-kimi-k2-7-code-cloud",
      "claude-code:ollama-glm-5-1-cloud",
      "claude-code:ollama-glm-5-2-cloud",
      "claude-code:ollama-minimax-m2-7-cloud",
      "claude-code:ollama-minimax-m3-cloud",
      "claude-code:claudex-luna",
      "claude-code:claudex-sol",
      "claude-code:claudex-terra",
      "claude-code:ollama-gpt-oss-20b-cloud",
      "claude-code:ollama-nemotron-3-nano-cloud",
      "claude-code:ollama-nemotron-3-super-cloud",
    ]);
    expect(
      rows.find(({ id }) => id === "claude-code:deepseek-v4-pro")?.name
    ).toBe("Claude Agent - DeepSeek v4 Pro Thinking (DeepSeek API)");
    expect(
      rows.find(({ id }) => id === "claude-code:deepseek-v4-pro")?.catalog
        ?.controls
    ).toEqual([
      expect.objectContaining({
        id: "reasoning",
        order: 0,
        width: "standard",
        displayLabel: "Thinking effort",
        allowedValues: ["non-think", "think-high", "think-max"],
        defaultValue: "think-high",
        valueLabels: {
          '"non-think"': "None",
          '"think-high"': "High",
          '"think-max"': "Max",
        },
      }),
    ]);
    expect(
      rows.find(({ id }) => id === "claude-code:ollama-qwen3-5-cloud")?.name
    ).toBe("Claude Agent - Qwen 3.5 (Ollama Cloud)");
    expect(
      rows.find(({ id }) => id === "claude-code:ollama-deepseek-v4-flash-0731")
    ).toMatchObject({
      name: "Claude Agent - DeepSeek V4 Flash 0731 (Ollama Cloud)",
      catalog: {
        controls: [],
        capabilities: {
          mainSession: false,
          subagent: false,
          consultation: false,
          tools: false,
          vision: false,
        },
        availability: {
          selectable: false,
          code: "candidate",
        },
      },
    });
    expect(
      rows.find(({ id }) => id === "claude-code:ollama-deepseek-v4-flash-0731")
        ?.contextWindow
    ).toBeUndefined();
    expect(
      rows.find(({ id }) => id === "claude-code:openrouter-deepseek-v4-pro")
        ?.catalog?.controls
    ).toEqual([]);
  });

  it("projects one safe row when one logical entry has multiple interfaces", () => {
    const source = BUILT_IN_PROVIDER_CATALOG.find(
      ({ family }) => family.id === "qwen"
    )!;
    const entry: ProviderCatalogEntry = {
      ...source,
      interfaces: [
        {
          ...source.interfaces[0],
          consumers: ["claude-agent-main", "claude-agent-subagent"],
        },
        {
          ...source.interfaces[0],
          id: "consultation-proxy",
          consumers: ["consultation"],
        },
      ],
    };
    const rows = mergeProviderCatalogPickerModels(
      [],
      resolveProviderCatalog([entry], undefined),
      [entry],
      credentialPresent
    );

    expect(rows).toHaveLength(1);
    const serialized = JSON.stringify(rows[0]);
    expect(serialized).not.toContain("endpoint");
    expect(serialized).not.toContain("credentialRef");
    expect(serialized).not.toContain("nimbalyst.local-proxy");
  });

  it("fails closed with accessible reasons for disabled, invalid, adapter, and missing-credential routes", () => {
    const entry = BUILT_IN_PROVIDER_CATALOG[0];
    const disabled = resolveProviderCatalog(BUILT_IN_PROVIDER_CATALOG, {
      schemaVersion: 2,
      entries: [{ id: entry.id, disabled: true }],
    });
    const invalid: ProviderCatalogResolution = {
      schemaVersion: 2,
      entries: [],
      disabledIds: [],
      errors: [
        {
          scope: "entry",
          id: entry.id,
          code: "invalid-entry",
          message: "unsafe detail omitted",
        },
      ],
      fatalErrors: [],
    };
    const adapter: ProviderCatalogResolution = {
      ...invalid,
      errors: [
        {
          scope: "entry",
          id: entry.id,
          code: "adapter-required",
          message: "unsafe detail omitted",
        },
      ],
    };

    expect(
      mergeProviderCatalogPickerModels(
        [],
        disabled,
        BUILT_IN_PROVIDER_CATALOG,
        credentialPresent
      ).find(({ id }) => id === entry.model.persistedId)?.catalog?.availability
    ).toEqual({
      selectable: false,
      code: "disabled",
      reason: "This catalog entry is disabled in provider settings.",
    });
    expect(
      mergeProviderCatalogPickerModels(
        [],
        invalid,
        [entry],
        credentialPresent
      )[0].catalog?.availability.code
    ).toBe("invalid");
    expect(
      mergeProviderCatalogPickerModels(
        [],
        adapter,
        [entry],
        credentialPresent
      )[0].catalog?.availability.code
    ).toBe("adapter-required");
    expect(
      mergeProviderCatalogPickerModels(
        [],
        resolveProviderCatalog([entry], undefined),
        [entry],
        () => false
      )[0].catalog?.availability
    ).toEqual({
      selectable: false,
      code: "missing-credential",
      reason: "The required provider credential is unavailable.",
    });
  });

  it("closes every retained row when the catalog source has a fatal schema error", () => {
    const resolution = resolveProviderCatalog(BUILT_IN_PROVIDER_CATALOG, {
      schemaVersion: 999,
      entries: [],
    });
    expect(resolution.fatalErrors).not.toHaveLength(0);

    const rows = mergeProviderCatalogPickerModels(
      [],
      resolution,
      BUILT_IN_PROVIDER_CATALOG,
      credentialPresent
    );

    expect(rows).toHaveLength(BUILT_IN_PROVIDER_CATALOG.length);
    expect(
      rows.every(
        (row) =>
          row.catalog?.availability.selectable === false &&
          row.catalog.availability.code === "invalid" &&
          row.catalog.availability.reason ===
            "The provider catalog source is invalid and cannot be used."
      )
    ).toBe(true);
  });

  it("surfaces overlay add/override/disable and a future Qwen Nous fixture without renderer changes", () => {
    const qwen = BUILT_IN_PROVIDER_CATALOG.find(
      ({ family }) => family.id === "qwen"
    )!;
    const disabled = BUILT_IN_PROVIDER_CATALOG.find(
      ({ family }) => family.id === "glm"
    )!;
    const future: ProviderCatalogEntry = {
      ...qwen,
      id: "qwen-3-8-nous-fixture",
      provider: "nous",
      providerDisplayName: "Nous",
      displayName: "Qwen 3.8",
      model: {
        ...qwen.model,
        persistedId: "claude-code:ollama-qwen3-8-nous",
        providerModelId: "qwen3.8-nous",
        version: "3.8",
      },
      interfaces: qwen.interfaces.map((item) => ({
        ...item,
        modelAlias: "qwen3.8-nous",
      })),
    };
    const { id: _futureId, ...futurePatch } = future;
    const overlay: ProviderCatalogOverlay = {
      schemaVersion: 2,
      entries: [
        { id: qwen.id, patch: { displayName: "Qwen 3.5 Standard" } },
        { id: disabled.id, disabled: true },
        { id: future.id, patch: futurePatch },
      ],
    };
    const resolution = resolveProviderCatalog(
      BUILT_IN_PROVIDER_CATALOG,
      overlay
    );
    const rows = mergeProviderCatalogPickerModels(
      [],
      resolution,
      BUILT_IN_PROVIDER_CATALOG,
      credentialPresent
    );

    expect(
      rows.find(({ id }) => id === qwen.model.persistedId)?.name
    ).toContain("Qwen 3.5 Standard");
    expect(rows.find(({ id }) => id === future.model.persistedId)?.name).toBe(
      "Claude Agent - Qwen 3.8 (Nous)"
    );
    expect(
      rows.find(({ id }) => id === disabled.model.persistedId)?.catalog
        ?.availability.code
    ).toBe("disabled");
  });
});
