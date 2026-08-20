import type {
  ProviderControlCatalogEntry,
  ProviderControlDefinition,
  ProviderControlMapping,
  ProviderControlTarget,
  ProviderControlValue,
} from './providerControlContract';

const ALL_PHASES = { launch: true, restart: true, 'mid-session': true } as const;
const START_PHASES = { launch: true, restart: true, 'mid-session': false } as const;

function mapping(
  interfaceId: string,
  target: ProviderControlTarget,
  values: readonly string[],
): ProviderControlMapping {
  return {
    interfaceId,
    target,
    values: values.map((value) => ({ storedValue: value, resolvedValue: value })),
  };
}

function effortControl(interfaceId: string, target: ProviderControlTarget, allowedValues: readonly string[]): ProviderControlDefinition {
  return {
    id: 'reasoning-effort',
    settingId: 'effort-level',
    type: 'enum',
    label: 'Reasoning effort',
    helpText: 'Controls the reviewed reasoning-effort parameter for this model route.',
    defaultValue: 'high',
    allowedValues,
    applicability: ALL_PHASES,
    mappings: [mapping(interfaceId, target, allowedValues)],
  };
}

function thinkingControl(interfaceId: string): ProviderControlDefinition {
  return {
    id: 'extended-thinking',
    settingId: 'thinking-mode',
    type: 'enum',
    label: 'Extended thinking',
    helpText: 'Keeps adaptive thinking enabled or explicitly disables it for supported Claude models.',
    defaultValue: 'enabled',
    allowedValues: ['enabled', 'disabled'],
    applicability: START_PHASES,
    mappings: [{
      interfaceId,
      target: 'sdk.thinking.type',
      values: [
        { storedValue: 'enabled', operation: 'omit' },
        { storedValue: 'disabled', resolvedValue: 'disabled' },
      ],
    }],
  };
}

function entry(input: {
  id: string;
  provider: string;
  modelId: string;
  interfaceId: string;
  controls: readonly ProviderControlDefinition[];
}): ProviderControlCatalogEntry {
  return {
    id: input.id,
    provider: input.provider,
    modelId: input.modelId,
    interfaces: [input.interfaceId],
    consumers: ['main-session', 'subagent', 'consultation'],
    controls: input.controls,
  };
}

function normalizeEntryId(modelId: string): string {
  return modelId.toLowerCase().replace(/[^a-z0-9._:-]+/g, '-');
}

/**
 * Built-in reviewed controls. Unknown models intentionally receive no entry;
 * callers must not infer capabilities from a nearby provider or model.
 */
export function getBuiltInProviderControlEntry(modelId: string | undefined): ProviderControlCatalogEntry | undefined {
  if (!modelId) return undefined;
  const normalized = modelId.toLowerCase();

  if (normalized.startsWith('claude-code:')) {
    const variant = normalized.slice('claude-code:'.length).replace(/-1m$/, '');
    const supportsEffort = variant === 'fable' || variant.startsWith('opus') || variant.startsWith('sonnet');
    if (!supportsEffort) return undefined;
    const controls: ProviderControlDefinition[] = [
      effortControl('claude-agent-sdk', 'env.CLAUDE_CODE_EFFORT_LEVEL', ['low', 'medium', 'high', 'xhigh', 'max']),
    ];
    if (variant.startsWith('opus') || variant.startsWith('sonnet')) {
      controls.push(thinkingControl('claude-agent-sdk'));
    }
    return entry({
      id: normalizeEntryId(normalized),
      provider: 'claude-code',
      modelId,
      interfaceId: 'claude-agent-sdk',
      controls,
    });
  }

  if (normalized === 'model-launcher:deepseek-pro' || normalized === 'model-launcher:deepseek-flash') {
    return entry({
      id: normalizeEntryId(normalized),
      provider: 'model-launcher',
      modelId,
      interfaceId: 'unified-model-launcher',
      controls: [effortControl('unified-model-launcher', 'launcher.effort', ['low', 'medium', 'high', 'xhigh'])],
    });
  }

  return undefined;
}

export function getBuiltInProviderControlCatalog(modelId: string | undefined): readonly ProviderControlCatalogEntry[] {
  const entry = getBuiltInProviderControlEntry(modelId);
  return entry ? [entry] : [];
}

export function reconcileBuiltInProviderControlValues(
  modelId: string | undefined,
  values: Readonly<Record<string, ProviderControlValue | undefined>>,
): { values: Record<string, ProviderControlValue>; resets: Array<{ settingId: string; from: ProviderControlValue; to: ProviderControlValue }> } {
  const entry = getBuiltInProviderControlEntry(modelId);
  if (!entry) return { values: {}, resets: [] };
  const resolved: Record<string, ProviderControlValue> = {};
  const resets: Array<{ settingId: string; from: ProviderControlValue; to: ProviderControlValue }> = [];
  for (const control of entry.controls) {
    const current = values[control.settingId];
    let valid = current !== undefined;
    if (control.type === 'boolean') valid = typeof current === 'boolean';
    if (control.type === 'enum' || control.type === 'profile') {
      valid = typeof current === 'string' && control.allowedValues.includes(current);
    }
    if (control.type === 'number') {
      valid = typeof current === 'number' && Number.isFinite(current)
        && current >= control.minimum && current <= control.maximum;
    }
    resolved[control.settingId] = valid ? current! : control.defaultValue;
    if (current !== undefined && !valid) {
      resets.push({ settingId: control.settingId, from: current, to: control.defaultValue });
    }
  }
  return { values: resolved, resets };
}
