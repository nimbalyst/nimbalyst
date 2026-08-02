import type { AIModel } from "@nimbalyst/runtime/ai/server/types";
import type {
  ProviderCatalogControlValue,
  ProviderCatalogEntry,
  ProviderCatalogError,
  ProviderCatalogResolution,
} from "@nimbalyst/runtime/ai/server/providers/claudeCode/providerCatalog";

export type CatalogPickerAvailabilityCode =
  | "launchable"
  | "disabled"
  | "invalid"
  | "adapter-required"
  | "missing-credential";

export interface CatalogPickerControl {
  id: string;
  persistenceKey: string;
  displayLabel: string;
  helpText: string;
  allowedValues: readonly ProviderCatalogControlValue[];
  defaultValue: ProviderCatalogControlValue;
  valueLabels: Readonly<Record<string, string>>;
}

export interface CatalogPickerMetadata {
  entryId: string;
  family: string;
  version: string;
  contextWindow?: number;
  capabilities: Readonly<{
    mainSession: boolean;
    subagent: boolean;
    consultation: boolean;
    tools: boolean;
    vision: boolean;
  }>;
  controls: readonly CatalogPickerControl[];
  availability: Readonly<{
    selectable: boolean;
    code: CatalogPickerAvailabilityCode;
    reason?: string;
  }>;
}

export interface CatalogPickerModel extends AIModel {
  catalog: CatalogPickerMetadata;
}

export interface CatalogPickerSourceModel extends AIModel {
  catalog?: CatalogPickerMetadata;
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, "en", {
    numeric: true,
    sensitivity: "base",
  });
}

function compareEntries(
  left: ProviderCatalogEntry,
  right: ProviderCatalogEntry
): number {
  return (
    left.harness.order - right.harness.order ||
    left.family.order - right.family.order ||
    compareText(left.displayName, right.displayName) ||
    compareText(left.model.version, right.model.version) ||
    compareText(
      left.providerDisplayName ?? left.provider,
      right.providerDisplayName ?? right.provider
    ) ||
    compareText(left.id, right.id)
  );
}

function providerLabel(entry: ProviderCatalogEntry): string {
  if (entry.providerDisplayName?.trim())
    return entry.providerDisplayName.trim();
  return entry.provider
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function thinkingSuffix(entry: ProviderCatalogEntry): string {
  const thinkingControl = Object.values(entry.controls).find(
    (control) => control.persistenceKey === "thinking-mode"
  );
  return thinkingControl?.defaultValue === "enabled" ||
    thinkingControl?.defaultValue === true
    ? " Thinking"
    : "";
}

function projectControls(entry: ProviderCatalogEntry): CatalogPickerControl[] {
  return Object.entries(entry.controls)
    .sort(([left], [right]) => compareText(left, right))
    .map(([id, control]) => ({
      id,
      persistenceKey: control.persistenceKey,
      displayLabel:
        control.displayLabel ??
        id.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      helpText:
        control.helpText ??
        `Choose an allowed ${control.persistenceKey} value for this model.`,
      allowedValues: [...control.allowedValues],
      defaultValue: control.defaultValue,
      valueLabels: { ...(control.valueLabels ?? {}) },
    }));
}

function closedErrorAvailability(
  error: ProviderCatalogError
): CatalogPickerMetadata["availability"] {
  if (
    error.code === "adapter-required" ||
    error.code === "unsupported-interface" ||
    error.code === "unsupported-transport-profile"
  ) {
    return {
      selectable: false,
      code: "adapter-required",
      reason: "This catalog route requires a supported adapter.",
    };
  }
  return {
    selectable: false,
    code: "invalid",
    reason: "This catalog entry is invalid and cannot be launched.",
  };
}

function availabilityForEntry(
  entry: ProviderCatalogEntry,
  resolution: ProviderCatalogResolution,
  credentialPresent: (credentialRef: string) => boolean
): CatalogPickerMetadata["availability"] {
  if (resolution.fatalErrors.length > 0) {
    return {
      selectable: false,
      code: "invalid",
      reason: "The provider catalog source is invalid and cannot be used.",
    };
  }
  if (resolution.disabledIds.includes(entry.id)) {
    return {
      selectable: false,
      code: "disabled",
      reason: "This catalog entry is disabled in provider settings.",
    };
  }
  const error = resolution.errors.find(
    (candidate) => candidate.id === entry.id
  );
  if (error) return closedErrorAvailability(error);

  const mainInterfaces = entry.interfaces.filter((candidate) =>
    candidate.consumers.includes("claude-agent-main")
  );
  if (mainInterfaces.length !== 1) {
    return {
      selectable: false,
      code: "adapter-required",
      reason: "This catalog route requires a supported adapter.",
    };
  }
  if (!credentialPresent(mainInterfaces[0].credentialRef)) {
    return {
      selectable: false,
      code: "missing-credential",
      reason: "The required provider credential is unavailable.",
    };
  }
  return { selectable: true, code: "launchable" };
}

function toPickerModel(
  entry: ProviderCatalogEntry,
  resolution: ProviderCatalogResolution,
  credentialPresent: (credentialRef: string) => boolean
): CatalogPickerModel {
  return {
    id: entry.model.persistedId,
    name: `Claude Agent - ${entry.displayName}${thinkingSuffix(
      entry
    )} (${providerLabel(entry)})`,
    provider: "claude-code",
    maxTokens: 8192,
    contextWindow: entry.model.contextWindowSeedTokens,
    catalog: {
      entryId: entry.id,
      family: entry.family.id,
      version: entry.model.version,
      contextWindow: entry.model.contextWindowSeedTokens,
      capabilities: { ...entry.capabilities },
      controls: projectControls(entry),
      availability: availabilityForEntry(entry, resolution, credentialPresent),
    },
  };
}

/**
 * Replace renderer-owned catalog aliases with one safe row per normalized entry.
 * Native/direct/extension models retain their existing order and metadata.
 */
export function mergeProviderCatalogPickerModels(
  nativeModels: readonly AIModel[],
  resolution: ProviderCatalogResolution,
  defaults: readonly ProviderCatalogEntry[],
  credentialPresent: (credentialRef: string) => boolean
): CatalogPickerSourceModel[] {
  const activeById = new Map(
    resolution.entries.map((entry) => [entry.id, entry])
  );
  const unavailableDefaults = defaults.filter(
    (entry) =>
      !activeById.has(entry.id) &&
      (resolution.disabledIds.includes(entry.id) ||
        resolution.errors.some((error) => error.id === entry.id))
  );
  const candidates = [...resolution.entries, ...unavailableDefaults].sort(
    compareEntries
  );
  const catalogPersistedIds = new Set(
    candidates.map((entry) => entry.model.persistedId)
  );
  const preservedNative = nativeModels.filter(
    (model) => !catalogPersistedIds.has(model.id)
  );
  const seenPersistedIds = new Set<string>();
  const catalogRows = candidates
    .filter((entry) => {
      if (seenPersistedIds.has(entry.model.persistedId)) return false;
      seenPersistedIds.add(entry.model.persistedId);
      return true;
    })
    .map((entry) => toPickerModel(entry, resolution, credentialPresent));
  return [...preservedNative, ...catalogRows];
}
