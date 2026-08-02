import * as fs from "fs";
import * as path from "path";
import {
  PROVIDER_CATALOG_SCHEMA_VERSION,
  resolveProviderCatalog,
  validateProviderCatalogEntry,
  type ProviderCatalogEntry,
  type ProviderCatalogEntryPatch,
  type ProviderCatalogError,
  type ProviderCatalogOverlay,
  type ProviderCatalogResolution,
} from "./providerCatalog";
import { LOCAL_PROXY_CREDENTIAL_REF } from "./providerCatalogDefaults";

export const PROVIDER_CATALOG_OVERLAY_FILE = "provider-catalog-v2.json";
export const LEGACY_OLLAMA_BACKENDS_FILE = "ollama-backends.json";

const LEGACY_LOCAL_PROXY_TOKEN = "sk-nim-local-proxy";
const LEGACY_KEYS = new Set([
  "id",
  "persistedModel",
  "provider",
  "model",
  "upstreamModel",
  "upstreamBaseUrl",
  "baseUrl",
  "authToken",
  "claudeModelAlias",
]);
const RAW_CREDENTIAL_KEYS = new Set([
  "apiKey",
  "api_key",
  "auth_token",
  "password",
  "secret",
  "token",
]);
const COMMAND_KEYS = new Set([
  "args",
  "arguments",
  "command",
  "env",
  "environment",
  "executable",
  "shell",
]);
const STABLE_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]*$/;

interface LegacyOllamaBackend {
  id: string;
  persistedModel: string;
  provider: "ollama";
  model: string;
  upstreamModel: string;
  upstreamBaseUrl: string;
  baseUrl: string;
  authToken: typeof LEGACY_LOCAL_PROXY_TOKEN;
  claudeModelAlias: string;
}

export interface ProviderCatalogMigration {
  overlay: ProviderCatalogOverlay;
  errors: readonly ProviderCatalogError[];
}

export interface LoadedProviderCatalog {
  resolution: ProviderCatalogResolution;
  migration: Readonly<{
    performed: boolean;
    sourcePreserved: boolean;
    legacyPath?: string;
    overlayPath?: string;
  }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStableId(value: unknown): value is string {
  return isNonEmptyString(value) && STABLE_ID_PATTERN.test(value);
}

function compareStableStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function error(
  code: ProviderCatalogError["code"],
  message: string,
  id?: string,
  index?: number
): ProviderCatalogError {
  return {
    scope: id !== undefined || index !== undefined ? "entry" : "source",
    ...(id ? { id } : {}),
    ...(index === undefined ? {} : { index }),
    code,
    message,
  };
}

function validateLegacyBackend(
  value: unknown,
  index: number
): { backend?: LegacyOllamaBackend; error?: ProviderCatalogError } {
  const id = isRecord(value) && isStableId(value.id) ? value.id : undefined;
  if (!isRecord(value)) {
    return {
      error: error(
        "invalid-entry",
        "Legacy backend entry must be an object.",
        id,
        index
      ),
    };
  }
  const extraKeys = Object.keys(value).filter((key) => !LEGACY_KEYS.has(key));
  if (extraKeys.some((key) => COMMAND_KEYS.has(key))) {
    return {
      error: error(
        "arbitrary-command",
        `${id ?? "Legacy backend"} contains an arbitrary command field.`,
        id,
        index
      ),
    };
  }
  if (extraKeys.some((key) => RAW_CREDENTIAL_KEYS.has(key))) {
    return {
      error: error(
        "raw-credential",
        `${id ?? "Legacy backend"} contains a raw credential field.`,
        id,
        index
      ),
    };
  }
  if (extraKeys.length > 0) {
    return {
      error: error(
        "invalid-entry",
        `${id ?? "Legacy backend"} contains unsupported fields.`,
        id,
        index
      ),
    };
  }
  if (value.authToken !== LEGACY_LOCAL_PROXY_TOKEN) {
    return {
      error: error(
        "raw-credential",
        `${
          id ?? "Legacy backend"
        } must migrate to a named credential reference.`,
        id,
        index
      ),
    };
  }
  if (
    !isNonEmptyString(value.id) ||
    !isNonEmptyString(value.persistedModel) ||
    value.provider !== "ollama" ||
    !isNonEmptyString(value.model) ||
    !isNonEmptyString(value.upstreamModel) ||
    !isNonEmptyString(value.upstreamBaseUrl) ||
    !isNonEmptyString(value.baseUrl) ||
    !isNonEmptyString(value.claudeModelAlias)
  ) {
    return {
      error: error(
        "invalid-entry",
        `${id ?? "Legacy backend"} is missing a required field.`,
        id,
        index
      ),
    };
  }
  return { backend: value as unknown as LegacyOllamaBackend };
}

function legacyFamily(model: string): string {
  const family = model.toLowerCase().match(/^[a-z0-9]+/)?.[0];
  return family ?? "custom";
}

function legacyFamilyOrder(family: string): number {
  return (
    {
      deepseek: 20,
      qwen: 30,
      kimi: 40,
      glm: 50,
      minimax: 60,
      codex: 70,
      grok: 80,
      gpt: 90,
      nemotron: 100,
    }[family] ?? 1_000
  );
}

function legacyToCatalogEntry(
  legacy: LegacyOllamaBackend,
  base?: ProviderCatalogEntry
): ProviderCatalogEntry {
  return {
    id: legacy.id,
    provider: legacy.provider,
    harness: base?.harness ?? { id: "claude-agent", order: 10 },
    family:
      base?.family ??
      ({
        id: legacyFamily(legacy.model),
        order: legacyFamilyOrder(legacyFamily(legacy.model)),
      } as const),
    displayName: base?.displayName ?? legacy.model,
    model: {
      persistedId: legacy.persistedModel,
      persistedIdNamespace: "claude-code:ollama-",
      providerModelId: legacy.model,
      upstreamModel: legacy.upstreamModel,
      version: legacy.model,
    },
    capabilities: base?.capabilities ?? {
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
        endpoint: legacy.baseUrl,
        upstreamEndpoint: legacy.upstreamBaseUrl,
        credentialRef: LOCAL_PROXY_CREDENTIAL_REF,
        modelAlias: legacy.claudeModelAlias,
      },
    ],
    controls: base?.controls ?? {},
  };
}

function toPatch(entry: ProviderCatalogEntry): ProviderCatalogEntryPatch {
  const { id: _id, ...patch } = entry;
  return patch;
}

function legacyOverridePatch(
  entry: ProviderCatalogEntry
): ProviderCatalogEntryPatch {
  return {
    provider: entry.provider,
    model: entry.model,
    interfaces: entry.interfaces,
  };
}

export function migrateLegacyOllamaBackends(
  legacyValue: unknown,
  defaults: readonly ProviderCatalogEntry[]
): ProviderCatalogMigration {
  const errors: ProviderCatalogError[] = [];
  const entries: Array<{
    id: string;
    disabled?: boolean;
    patch?: ProviderCatalogEntryPatch;
  }> = [];
  if (!Array.isArray(legacyValue) || legacyValue.length === 0) {
    errors.push(
      error(
        "invalid-overlay",
        "Legacy ollama-backends.json must contain a non-empty array."
      )
    );
  } else {
    const defaultsById = new Map(defaults.map((entry) => [entry.id, entry]));
    const ids = legacyValue.map((candidate) =>
      isRecord(candidate) && isStableId(candidate.id) ? candidate.id : undefined
    );
    const duplicateIds = new Set(
      ids.filter(
        (id): id is string =>
          id !== undefined &&
          ids.filter((candidate) => candidate === id).length > 1
      )
    );
    for (const duplicateId of [...duplicateIds].sort()) {
      errors.push(
        error(
          "duplicate-id",
          `${duplicateId} has duplicate legacy entries and was not migrated.`,
          duplicateId
        )
      );
    }
    legacyValue.forEach((candidate, index) => {
      const candidateId = ids[index];
      if (candidateId && duplicateIds.has(candidateId)) return;
      const validation = validateLegacyBackend(candidate, index);
      if (validation.error) {
        errors.push(validation.error);
        return;
      }
      const base = defaultsById.get(validation.backend!.id);
      const migrated = legacyToCatalogEntry(validation.backend!, base);
      const entryError = validateProviderCatalogEntry(migrated);
      if (entryError) {
        errors.push({ ...entryError, scope: "entry", index });
        return;
      }
      entries.push({
        id: migrated.id,
        patch: base ? legacyOverridePatch(migrated) : toPatch(migrated),
      });
    });

    if (errors.length === 0) {
      const legacyIds = new Set(entries.map((entry) => entry.id));
      for (const defaultEntry of defaults) {
        if (!legacyIds.has(defaultEntry.id)) {
          entries.push({ id: defaultEntry.id, disabled: true });
        }
      }
    }
  }

  entries.sort((left, right) => compareStableStrings(left.id, right.id));
  errors.sort(
    (left, right) =>
      compareStableStrings(left.id ?? "", right.id ?? "") ||
      compareStableStrings(left.code, right.code) ||
      (left.index ?? -1) - (right.index ?? -1)
  );
  return {
    overlay: {
      schemaVersion: PROVIDER_CATALOG_SCHEMA_VERSION,
      entries,
      migration: {
        source: LEGACY_OLLAMA_BACKENDS_FILE,
        sourceSchemaVersion: 1,
        ...(errors.length === 0 ? {} : { errors }),
      },
    },
    errors,
  };
}

function parseJson(
  raw: string,
  sourceLabel: string
): { value?: unknown; error?: ProviderCatalogError } {
  try {
    return { value: JSON.parse(raw) };
  } catch {
    return {
      error: error(
        "malformed-json",
        `${sourceLabel} contains malformed JSON and was not applied.`
      ),
    };
  }
}

/** Read the current overlay without performing legacy migration writes. */
export function readProviderCatalogFromDirectory(
  directory: string,
  defaults: readonly ProviderCatalogEntry[]
): LoadedProviderCatalog {
  const overlayPath = path.join(directory, PROVIDER_CATALOG_OVERLAY_FILE);
  const legacyPath = path.join(directory, LEGACY_OLLAMA_BACKENDS_FILE);
  const legacyExists = fs.existsSync(legacyPath);
  if (!fs.existsSync(overlayPath)) {
    return {
      resolution: resolveProviderCatalog(defaults, undefined),
      migration: {
        performed: false,
        sourcePreserved: legacyExists,
        legacyPath,
        overlayPath,
      },
    };
  }
  let raw: string;
  try {
    raw = fs.readFileSync(overlayPath, "utf-8");
  } catch {
    const readError = error(
      "invalid-overlay",
      "Provider catalog overlay could not be read and was not applied."
    );
    return {
      resolution: resolveProviderCatalog(defaults, undefined, [readError]),
      migration: {
        performed: false,
        sourcePreserved: legacyExists,
        legacyPath,
        overlayPath,
      },
    };
  }
  const parsed = parseJson(raw, PROVIDER_CATALOG_OVERLAY_FILE);
  return {
    resolution: resolveProviderCatalog(
      defaults,
      parsed.value,
      parsed.error ? [parsed.error] : []
    ),
    migration: {
      performed: false,
      sourcePreserved: legacyExists,
      legacyPath,
      overlayPath,
    },
  };
}

export function loadProviderCatalogFromDirectory(
  directory: string,
  defaults: readonly ProviderCatalogEntry[]
): LoadedProviderCatalog {
  const overlayPath = path.join(directory, PROVIDER_CATALOG_OVERLAY_FILE);
  const legacyPath = path.join(directory, LEGACY_OLLAMA_BACKENDS_FILE);
  const legacyExists = fs.existsSync(legacyPath);

  if (fs.existsSync(overlayPath)) {
    return readProviderCatalogFromDirectory(directory, defaults);
  }

  if (!legacyExists) {
    return {
      resolution: resolveProviderCatalog(defaults, undefined),
      migration: {
        performed: false,
        sourcePreserved: false,
        legacyPath,
        overlayPath,
      },
    };
  }

  let legacyRaw: string;
  try {
    legacyRaw = fs.readFileSync(legacyPath, "utf-8");
  } catch {
    const readError = error(
      "invalid-overlay",
      "Legacy ollama-backends.json could not be read and was not migrated."
    );
    return {
      resolution: resolveProviderCatalog(defaults, undefined, [readError]),
      migration: {
        performed: false,
        sourcePreserved: true,
        legacyPath,
        overlayPath,
      },
    };
  }
  const parsedLegacy = parseJson(legacyRaw, LEGACY_OLLAMA_BACKENDS_FILE);
  if (parsedLegacy.error) {
    return {
      resolution: resolveProviderCatalog(defaults, undefined, [
        parsedLegacy.error,
      ]),
      migration: {
        performed: false,
        sourcePreserved: true,
        legacyPath,
        overlayPath,
      },
    };
  }

  const migration = migrateLegacyOllamaBackends(parsedLegacy.value, defaults);
  let writeError: ProviderCatalogError | undefined;
  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      overlayPath,
      `${JSON.stringify(migration.overlay, null, 2)}\n`,
      { encoding: "utf-8", flag: "wx" }
    );
  } catch (caught) {
    if ((caught as NodeJS.ErrnoException).code === "EEXIST") {
      return loadProviderCatalogFromDirectory(directory, defaults);
    }
    writeError = error(
      "write-failed",
      "Provider catalog migration could not be persisted; the legacy file remains unchanged."
    );
  }
  return {
    resolution: resolveProviderCatalog(
      defaults,
      migration.overlay,
      writeError ? [writeError] : []
    ),
    migration: {
      performed: writeError === undefined,
      sourcePreserved: true,
      legacyPath,
      overlayPath,
    },
  };
}

export function loadProviderCatalog(
  defaults: readonly ProviderCatalogEntry[]
): LoadedProviderCatalog {
  const appData = process.env.APPDATA;
  if (!appData || process.env.VITEST) {
    return {
      resolution: resolveProviderCatalog(defaults, undefined),
      migration: { performed: false, sourcePreserved: false },
    };
  }
  return loadProviderCatalogFromDirectory(
    path.join(appData, "@nimbalyst", "electron"),
    defaults
  );
}

/** Read the current production overlay on every call without migration I/O. */
export function readProviderCatalog(
  defaults: readonly ProviderCatalogEntry[]
): LoadedProviderCatalog {
  const appData = process.env.APPDATA;
  if (!appData || process.env.VITEST) {
    return {
      resolution: resolveProviderCatalog(defaults, undefined),
      migration: { performed: false, sourcePreserved: false },
    };
  }
  return readProviderCatalogFromDirectory(
    path.join(appData, "@nimbalyst", "electron"),
    defaults
  );
}
