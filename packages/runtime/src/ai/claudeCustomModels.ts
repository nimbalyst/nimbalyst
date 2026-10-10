/**
 * Custom Claude Agent models.
 *
 * Users who route Claude Code through their own gateway (a local model router,
 * a corporate proxy) name their models in Claude's settings.json under
 * `modelPicker.options`. Nimbalyst stores such a selection as
 * `claude-code:custom/<model>` (or `claude-code-cli:custom/<model>`) and passes
 * `<model>` to the SDK / CLI verbatim: no pinning, no `[1m]` rewriting, case
 * preserved. The `custom/` namespace can never collide with a built-in variant,
 * so a router model named `opus` still stays a custom model.
 *
 * `behavesAs` (a full Anthropic model id such as `claude-opus-4-8`) tells
 * Nimbalyst which built-in variant's capabilities to assume (context window,
 * effort, thinking). Options are registered per process by whoever loads the
 * model list (main from Claude settings, renderer from the fetched model list).
 */

import {
  baseContextWindowForVariant,
  normalizeClaudeCodeVariant,
  type ClaudeCodeVariant,
} from './modelConstants';
import type { AIModel } from './server/types';

export const CLAUDE_CUSTOM_MODEL_PREFIX = 'custom/';

export interface ClaudeCustomModelOption {
  /** Model name sent to the SDK / CLI verbatim (e.g. `Fast`). */
  model: string;
  label?: string;
  description?: string;
  /** Full Anthropic model id whose capabilities this model shares. */
  behavesAs?: string;
}

/** True when a Claude Code model segment (the part after `provider:`) is custom. */
export function isClaudeCustomModelSegment(modelSegment: string | undefined | null): boolean {
  return !!modelSegment
    && modelSegment.startsWith(CLAUDE_CUSTOM_MODEL_PREFIX)
    && modelSegment.length > CLAUDE_CUSTOM_MODEL_PREFIX.length;
}

/** `custom/Fast` -> `Fast`; null for non-custom segments. */
export function claudeCustomModelName(modelSegment: string | undefined | null): string | null {
  return isClaudeCustomModelSegment(modelSegment)
    ? modelSegment!.slice(CLAUDE_CUSTOM_MODEL_PREFIX.length)
    : null;
}

/** `Fast` -> `custom/Fast`. */
export function toClaudeCustomModelSegment(model: string): string {
  return `${CLAUDE_CUSTOM_MODEL_PREFIX}${model}`;
}

/**
 * Custom model name from a combined (`claude-code:custom/Fast`) or bare
 * (`custom/Fast`) id. Null when the id is not a custom Claude model.
 */
export function claudeCustomModelNameFromId(modelId: string | undefined | null): string | null {
  if (!modelId) return null;
  const colon = modelId.indexOf(':');
  if (colon === -1) return claudeCustomModelName(modelId);
  const provider = modelId.slice(0, colon);
  if (provider !== 'claude-code' && provider !== 'claude-code-cli') return null;
  return claudeCustomModelName(modelId.slice(colon + 1));
}

let registeredOptions = new Map<string, ClaudeCustomModelOption>();

/**
 * Record custom options for capability lookups in this process. Upserts rather
 * than replaces: the list is per workspace, and a session in another workspace
 * must keep resolving its own model's capabilities.
 */
export function registerClaudeCustomModelOptions(options: readonly ClaudeCustomModelOption[]): void {
  for (const option of options) registeredOptions.set(option.model, option);
}

export function getClaudeCustomModelOption(model: string): ClaudeCustomModelOption | undefined {
  return registeredOptions.get(model);
}

/**
 * Built-in variant implied by a `behavesAs` id: `claude-opus-4-8` -> `opus-4-8`,
 * `claude-sonnet-5-5` -> `sonnet`. Undefined when unrecognized.
 */
export function variantForBehavesAs(behavesAs: string | undefined): ClaudeCodeVariant | undefined {
  if (!behavesAs) return undefined;
  const stripped = behavesAs.trim().toLowerCase()
    .replace(/\[1m\]$/, '')
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '');
  // Drop trailing version segments until something matches, so a generation we
  // don't list (`haiku-4-5`, `opus-4-1`) still lands on its family.
  const parts = stripped.split('-');
  for (let n = parts.length; n > 0; n--) {
    const variant = normalizeClaudeCodeVariant(parts.slice(0, n).join('-'));
    if (variant) return variant;
  }
  return undefined;
}

/**
 * Built-in variant whose capabilities a model id should get. For a built-in id
 * this is undefined (callers use their normal path); for a custom id it comes
 * from the registered option's `behavesAs`.
 */
export function behavesAsVariantForModelId(modelId: string | undefined | null): ClaudeCodeVariant | undefined {
  const name = claudeCustomModelNameFromId(modelId);
  if (!name) return undefined;
  return variantForBehavesAs(registeredOptions.get(name)?.behavesAs);
}

// ---------------------------------------------------------------------------
// Discovery from Claude settings (`modelPicker`)
// ---------------------------------------------------------------------------

export interface ClaudeModelPickerConfig {
  options: ClaudeCustomModelOption[];
  replaceBuiltInOptions: boolean;
}

const EMPTY_PICKER: ClaudeModelPickerConfig = Object.freeze({ options: [], replaceBuiltInOptions: false }) as ClaudeModelPickerConfig;

const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

/**
 * Effective `modelPicker` from parsed Claude settings files, given lowest to
 * highest precedence (user, project, local). The highest-precedence file that
 * defines `modelPicker` supplies it wholesale; entries without a usable
 * `model` are dropped, and duplicates keep the first occurrence.
 */
export function resolveClaudeModelPicker(settingsLowToHigh: readonly unknown[]): ClaudeModelPickerConfig {
  let picker: unknown;
  for (const settings of settingsLowToHigh) {
    if (settings && typeof settings === 'object' && 'modelPicker' in settings) {
      picker = (settings as { modelPicker?: unknown }).modelPicker;
    }
  }
  if (!picker || typeof picker !== 'object') return EMPTY_PICKER;

  const raw = (picker as { options?: unknown }).options;
  const options: ClaudeCustomModelOption[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const model = optionalString(e.model);
    if (!model || seen.has(model)) continue;
    seen.add(model);
    options.push({
      model,
      label: optionalString(e.label),
      description: optionalString(e.description),
      behavesAs: optionalString(e.behavesAs),
    });
  }

  return {
    options,
    // Hiding the built-ins with nothing to replace them would empty the picker.
    replaceBuiltInOptions: options.length > 0 && (picker as { replaceBuiltInOptions?: unknown }).replaceBuiltInOptions === true,
  };
}

type ClaudeModelPickerSource = (workspacePath: string | undefined) => Promise<ClaudeModelPickerConfig>;
let pickerSource: ClaudeModelPickerSource | null = null;

/** Injected by the host (Electron main reads Claude's settings files). */
export function setClaudeModelPickerSource(source: ClaudeModelPickerSource | null): void {
  pickerSource = source;
}

/**
 * Apply the user's `modelPicker` to a Claude provider's built-in catalog:
 * custom rows first, built-ins after unless `replaceBuiltInOptions`.
 * Registers the options for capability lookups as a side effect.
 */
export async function withClaudeCustomModels(
  provider: 'claude-code' | 'claude-code-cli',
  builtIns: AIModel[],
  workspacePath: string | undefined,
): Promise<AIModel[]> {
  const picker = pickerSource ? await pickerSource(workspacePath) : EMPTY_PICKER;
  if (picker.options.length === 0) return builtIns;
  registerClaudeCustomModelOptions(picker.options);

  const prefix = provider === 'claude-code-cli' ? 'Claude Code CLI' : 'Claude Agent';
  const custom: AIModel[] = picker.options.map((option) => {
    const variant = variantForBehavesAs(option.behavesAs);
    return {
      id: `${provider}:${toClaudeCustomModelSegment(option.model)}`,
      name: `${prefix} · ${option.label ?? option.model}`,
      provider,
      maxTokens: 8192,
      // Without behavesAs we cannot know the window; 200k is the conservative seed
      // the runtime corrects from the SDK's reported usage.
      contextWindow: variant ? baseContextWindowForVariant(variant) : 200_000,
      ...(option.behavesAs ? { behavesAs: option.behavesAs } : {}),
    };
  });

  return picker.replaceBuiltInOptions ? custom : [...custom, ...builtIns];
}

/**
 * Register custom options from a fetched model catalog (renderer side), so
 * labels and capability checks work without reading Claude settings directly.
 * Inverts the row shape built by withClaudeCustomModels.
 */
export function registerClaudeCustomModelsFromCatalog(models: readonly AIModel[]): void {
  const options: ClaudeCustomModelOption[] = [];
  for (const model of models) {
    const name = claudeCustomModelNameFromId(model.id);
    if (!name) continue;
    const separator = model.name.indexOf(' · ');
    options.push({
      model: name,
      label: separator === -1 ? model.name : model.name.slice(separator + 3),
      behavesAs: model.behavesAs,
    });
  }
  registerClaudeCustomModelOptions(options);
}
