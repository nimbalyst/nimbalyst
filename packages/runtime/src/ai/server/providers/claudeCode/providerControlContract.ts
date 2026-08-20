/**
 * Data-only contract for reviewed Claude Agent catalog controls.
 *
 * The catalog declares semantic settings and exact adapter mappings. It may
 * not declare executable transforms, credentials, endpoints, or fallback
 * routes. Runtime consumers resolve one exact entry/interface pair, persist
 * the immutable receipt, and then hand the resolved parameters to a reviewed
 * adapter.
 */

export const PROVIDER_CONTROL_CONTRACT_VERSION = 1 as const;

export type ProviderControlConsumer = 'main-session' | 'subagent' | 'consultation';
export type ProviderControlPhase = 'launch' | 'restart' | 'mid-session';
export type ProviderControlValue = string | number | boolean;
export type ProviderControlTarget =
  | 'sdk.thinking.type'
  | 'env.CLAUDE_CODE_EFFORT_LEVEL'
  | 'request.thinking.type'
  | 'request.output_config.effort'
  | 'launcher.effort'
  | 'launcher.profile';

export interface ProviderControlMappingValue {
  storedValue: ProviderControlValue;
  operation?: 'set' | 'omit';
  resolvedValue?: ProviderControlValue;
}

export interface ProviderControlMapping {
  interfaceId: string;
  target: ProviderControlTarget;
  values: readonly ProviderControlMappingValue[];
}

interface ProviderControlBase {
  id: string;
  settingId: string;
  label: string;
  helpText: string;
  defaultValue: ProviderControlValue;
  applicability: Readonly<Record<ProviderControlPhase, boolean>>;
  mappings: readonly ProviderControlMapping[];
}

export interface ProviderBooleanControl extends ProviderControlBase {
  type: 'boolean';
  defaultValue: boolean;
}

export interface ProviderEnumControl extends ProviderControlBase {
  type: 'enum' | 'profile';
  defaultValue: string;
  allowedValues: readonly string[];
}

export interface ProviderNumberControl extends ProviderControlBase {
  type: 'number';
  defaultValue: number;
  minimum: number;
  maximum: number;
  step?: number;
}

export type ProviderControlDefinition =
  | ProviderBooleanControl
  | ProviderEnumControl
  | ProviderNumberControl;

export interface ProviderControlCatalogEntry {
  id: string;
  provider: string;
  modelId: string;
  interfaces: readonly string[];
  consumers: readonly ProviderControlConsumer[];
  controls: readonly ProviderControlDefinition[];
}

export interface ResolvedProviderControlParameter {
  controlId: string;
  settingId: string;
  interfaceId: string;
  target: ProviderControlTarget;
  operation: 'set' | 'omit';
  value?: ProviderControlValue;
}

export interface ProviderControlSnapshot {
  schemaVersion: typeof PROVIDER_CONTROL_CONTRACT_VERSION;
  catalogEntryId: string;
  provider: string;
  modelId: string;
  interfaceId: string;
  consumer: ProviderControlConsumer;
  phase: ProviderControlPhase;
  requested: Readonly<Record<string, ProviderControlValue>>;
  resolved: Readonly<Record<string, ProviderControlValue>>;
  parameters: readonly ResolvedProviderControlParameter[];
}

export class ProviderControlContractError extends Error {
  constructor(
    public readonly code:
      | 'invalid-catalog'
      | 'route-not-found'
      | 'unsupported-interface'
      | 'unsupported-consumer'
      | 'invalid-controls'
      | 'adapter-required',
    message: string,
  ) {
    super(message);
    this.name = 'ProviderControlContractError';
  }
}

const STABLE_ID = /^[a-z0-9][a-z0-9._:-]*$/;
const TARGETS = new Set<ProviderControlTarget>([
  'sdk.thinking.type',
  'env.CLAUDE_CODE_EFFORT_LEVEL',
  'request.thinking.type',
  'request.output_config.effort',
  'launcher.effort',
  'launcher.profile',
]);

function fail(
  code: ProviderControlContractError['code'],
  message: string,
): never {
  throw new ProviderControlContractError(code, message);
}

function isControlValue(value: unknown): value is ProviderControlValue {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function sameValue(left: ProviderControlValue, right: ProviderControlValue): boolean {
  return typeof left === typeof right && left === right;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

function assertStableId(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !STABLE_ID.test(value)) {
    fail('invalid-catalog', `${label} must be a stable lowercase identifier.`);
  }
}

function assertControlValue(
  control: ProviderControlDefinition,
  value: unknown,
): asserts value is ProviderControlValue {
  if (!isControlValue(value)) {
    fail('invalid-controls', `Control ${control.id} has a non-scalar value.`);
  }
  switch (control.type) {
    case 'boolean':
      if (typeof value !== 'boolean') {
        fail('invalid-controls', `Control ${control.id} requires a boolean value.`);
      }
      break;
    case 'enum':
    case 'profile':
      if (typeof value !== 'string' || !control.allowedValues.includes(value)) {
        fail('invalid-controls', `Control ${control.id} received an unsupported value.`);
      }
      break;
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)
        || value < control.minimum || value > control.maximum) {
        fail('invalid-controls', `Control ${control.id} is outside its reviewed range.`);
      }
      if (control.step !== undefined) {
        const steps = (value - control.minimum) / control.step;
        if (Math.abs(steps - Math.round(steps)) > Number.EPSILON * 10) {
          fail('invalid-controls', `Control ${control.id} does not match its reviewed step.`);
        }
      }
      break;
    }
  }
}

function validateCatalogEntry(entry: ProviderControlCatalogEntry): void {
  assertStableId(entry.id, 'Catalog entry id');
  assertStableId(entry.provider, `Catalog entry ${entry.id} provider`);
  if (!entry.modelId || typeof entry.modelId !== 'string') {
    fail('invalid-catalog', `Catalog entry ${entry.id} requires an exact model id.`);
  }
  if (!entry.interfaces.length || new Set(entry.interfaces).size !== entry.interfaces.length) {
    fail('invalid-catalog', `Catalog entry ${entry.id} requires unique reviewed interfaces.`);
  }
  for (const interfaceId of entry.interfaces) {
    assertStableId(interfaceId, `Catalog entry ${entry.id} interface`);
  }
  if (!entry.consumers.length || new Set(entry.consumers).size !== entry.consumers.length) {
    fail('invalid-catalog', `Catalog entry ${entry.id} requires unique consumers.`);
  }
  const allowedConsumers = new Set<ProviderControlConsumer>(['main-session', 'subagent', 'consultation']);
  if (entry.consumers.some((consumer) => !allowedConsumers.has(consumer))) {
    fail('invalid-catalog', `Catalog entry ${entry.id} has an unsupported consumer.`);
  }
  if (!entry.controls.length) {
    fail('invalid-catalog', `Catalog entry ${entry.id} requires at least one control.`);
  }

  const controlIds = new Set<string>();
  const settingIds = new Set<string>();
  for (const control of entry.controls) {
    assertStableId(control.id, `Catalog entry ${entry.id} control id`);
    assertStableId(control.settingId, `Catalog entry ${entry.id} setting id`);
    if (controlIds.has(control.id) || settingIds.has(control.settingId)) {
      fail('invalid-catalog', `Catalog entry ${entry.id} has duplicate control identities.`);
    }
    controlIds.add(control.id);
    settingIds.add(control.settingId);
    if (!control.label || !control.helpText) {
      fail('invalid-catalog', `Control ${control.id} requires label and help text.`);
    }
    if (Object.values(control.applicability).some((value) => typeof value !== 'boolean')) {
      fail('invalid-catalog', `Control ${control.id} has invalid applicability.`);
    }
    if ((control.type === 'enum' || control.type === 'profile')
      && (!control.allowedValues.length || new Set(control.allowedValues).size !== control.allowedValues.length)) {
      fail('invalid-catalog', `Control ${control.id} requires unique allowed values.`);
    }
    if (control.type === 'number'
      && (!Number.isFinite(control.minimum) || !Number.isFinite(control.maximum)
        || control.minimum > control.maximum
        || (control.step !== undefined && (!Number.isFinite(control.step) || control.step <= 0)))) {
      fail('invalid-catalog', `Control ${control.id} has an invalid numeric range.`);
    }
    assertControlValue(control, control.defaultValue);
    if (!control.mappings.length) {
      fail('invalid-catalog', `Control ${control.id} has no reviewed transport mapping.`);
    }
    for (const mapping of control.mappings) {
      if (!entry.interfaces.includes(mapping.interfaceId)) {
        fail('invalid-catalog', `Control ${control.id} maps an unreviewed interface.`);
      }
      if (!TARGETS.has(mapping.target) || !mapping.values.length) {
        fail('invalid-catalog', `Control ${control.id} has an invalid transport mapping.`);
      }
      const mappedValues = new Set<string>();
      for (const item of mapping.values) {
        assertControlValue(control, item.storedValue);
        const mappedKey = `${typeof item.storedValue}:${String(item.storedValue)}`;
        if (mappedValues.has(mappedKey)) {
          fail('invalid-catalog', `Control ${control.id} maps one stored value more than once.`);
        }
        mappedValues.add(mappedKey);
        const operation = item.operation ?? 'set';
        if (operation === 'set' && !isControlValue(item.resolvedValue)) {
          fail('invalid-catalog', `Control ${control.id} has a set mapping without a value.`);
        }
        if (operation === 'omit' && item.resolvedValue !== undefined) {
          fail('invalid-catalog', `Control ${control.id} has an omit mapping with a value.`);
        }
      }
    }
  }
}

function validateResolvedTarget(
  target: ProviderControlTarget,
  operation: 'set' | 'omit',
  value: ProviderControlValue | undefined,
): void {
  if (operation === 'omit') return;
  switch (target) {
    case 'sdk.thinking.type':
    case 'request.thinking.type':
      if (value !== 'enabled' && value !== 'disabled' && value !== 'adaptive') {
        fail('adapter-required', `${target} requires a reviewed thinking mode.`);
      }
      return;
    case 'env.CLAUDE_CODE_EFFORT_LEVEL':
      if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(String(value))) {
        fail('adapter-required', `${target} requires a reviewed effort level.`);
      }
      return;
    case 'request.output_config.effort':
      if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(String(value))) {
        fail('adapter-required', `${target} requires a reviewed effort level.`);
      }
      return;
    case 'launcher.effort':
      if (!['low', 'medium', 'high', 'xhigh'].includes(String(value))) {
        fail('adapter-required', `${target} requires a launcher-supported effort level.`);
      }
      return;
    case 'launcher.profile':
      if (typeof value !== 'string' || !value.trim()) {
        fail('adapter-required', `${target} requires an exact launcher profile.`);
      }
      return;
  }
}

/**
 * Resolve one exact catalog route. Missing entries, interfaces, settings, or
 * mappings are errors; the contract never searches for a nearby model or
 * provider and never silently drops a stale value.
 */
export function resolveProviderControlSnapshot(input: {
  catalog: readonly ProviderControlCatalogEntry[];
  catalogEntryId: string;
  interfaceId: string;
  consumer: ProviderControlConsumer;
  phase: ProviderControlPhase;
  requested?: Readonly<Record<string, unknown>>;
}): Readonly<ProviderControlSnapshot> {
  const ids = new Set<string>();
  for (const entry of input.catalog) {
    validateCatalogEntry(entry);
    if (ids.has(entry.id)) fail('invalid-catalog', `Duplicate catalog entry ${entry.id}.`);
    ids.add(entry.id);
  }

  const entry = input.catalog.find((candidate) => candidate.id === input.catalogEntryId);
  if (!entry) fail('route-not-found', `No reviewed route exists for ${input.catalogEntryId}.`);
  if (!entry.interfaces.includes(input.interfaceId)) {
    fail('unsupported-interface', `Route ${entry.id} does not support ${input.interfaceId}.`);
  }
  if (!entry.consumers.includes(input.consumer)) {
    fail('unsupported-consumer', `Route ${entry.id} does not support ${input.consumer}.`);
  }

  const controlsBySetting = new Map(entry.controls.map((control) => [control.settingId, control]));
  for (const settingId of Object.keys(input.requested ?? {})) {
    if (!controlsBySetting.has(settingId)) {
      fail('invalid-controls', `Route ${entry.id} received stale setting ${settingId}.`);
    }
  }

  const requested: Record<string, ProviderControlValue> = {};
  const resolved: Record<string, ProviderControlValue> = {};
  const parameters: ResolvedProviderControlParameter[] = [];
  const usedTargets = new Set<ProviderControlTarget>();

  for (const control of entry.controls) {
    const supplied = input.requested?.[control.settingId];
    if (supplied !== undefined && !control.applicability[input.phase]) {
      fail('invalid-controls', `Control ${control.id} cannot change during ${input.phase}.`);
    }
    const value = supplied ?? control.defaultValue;
    assertControlValue(control, value);
    if (supplied !== undefined) requested[control.settingId] = value;
    resolved[control.settingId] = value;

    const mappings = control.mappings.filter((mapping) => mapping.interfaceId === input.interfaceId);
    if (!mappings.length) {
      fail('adapter-required', `Control ${control.id} has no ${input.interfaceId} adapter.`);
    }
    for (const mapping of mappings) {
      if (usedTargets.has(mapping.target)) {
        fail('invalid-catalog', `Route ${entry.id} maps ${mapping.target} more than once.`);
      }
      usedTargets.add(mapping.target);
      const item = mapping.values.find((candidate) => sameValue(candidate.storedValue, value));
      if (!item) {
        fail('adapter-required', `Control ${control.id} has no mapping for its resolved value.`);
      }
      const operation = item.operation ?? 'set';
      validateResolvedTarget(mapping.target, operation, item.resolvedValue);
      parameters.push({
        controlId: control.id,
        settingId: control.settingId,
        interfaceId: input.interfaceId,
        target: mapping.target,
        operation,
        ...(operation === 'set' && { value: item.resolvedValue }),
      });
    }
  }

  return deepFreeze({
    schemaVersion: PROVIDER_CONTROL_CONTRACT_VERSION,
    catalogEntryId: entry.id,
    provider: entry.provider,
    modelId: entry.modelId,
    interfaceId: input.interfaceId,
    consumer: input.consumer,
    phase: input.phase,
    requested,
    resolved,
    parameters,
  });
}

/** Stable, redacted persistence form for the immutable per-session receipt. */
export function serializeProviderControlSnapshot(snapshot: ProviderControlSnapshot): string {
  return JSON.stringify(snapshot);
}
