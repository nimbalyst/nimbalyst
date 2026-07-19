import { claudeUsageService } from './ClaudeUsageService';
import { codexUsageService } from './CodexUsageService';
import { geminiUsageService } from './GeminiUsageService';
import {
  aggregateCapacityState,
  applicableCapacityWindows,
  capacityError,
  computeFreshness,
  decideProviderCapacity,
  effectiveResetAtForWindows,
  normalizeCapacityModelId,
  normalizedTimestamp,
  validatedRatio,
  type CapacityPreflightDecision,
  type CapacityPreflightOptions,
  type CapacityWindow,
  type FreshnessPolicy,
  type ProviderCapacityObservation,
  type ProviderCapacitySnapshotV1,
  type CapacitySourceDescriptor,
  type ProviderId,
} from './provider-capacity-types';

export interface ProviderCapacityRequest {
  provider: ProviderId;
  model?: string;
  /** Internal auth/profile scope. This value is used only in the in-memory key. */
  scopeKey?: string;
  /** Bypass the normalized cache and ask the collector for a fresh observation. */
  refresh?: boolean;
}

export interface ProviderCapacityCollectorRequest {
  provider: ProviderId;
  model?: string;
  scopeKey: string;
  signal: AbortSignal;
}

export type ProviderCapacityCollector = (
  request: ProviderCapacityCollectorRequest,
) => Promise<ProviderCapacityObservation>;

export type ProviderCapacityCollectors = Record<string, ProviderCapacityCollector | undefined>;

export interface ProviderCapacityServiceOptions {
  collectors?: ProviderCapacityCollectors;
  now?: () => number;
  freshness?: Partial<Record<string, Partial<FreshnessPolicy>>>;
  collectorTimeoutMs?: number;
  scheduleTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  cancelTimeout?: (handle: ReturnType<typeof setTimeout>) => void;
}

interface CacheEntry {
  observation: ProviderCapacityObservation;
  receivedAt: string;
  revision: number;
}

interface RefreshResult {
  entry: CacheEntry;
  cacheHit: boolean;
}

const MIN_STALE_AFTER_MS = 1_000;
const MAX_STALE_AFTER_MS = 30 * 60 * 1_000;
const MAX_EXPIRE_AFTER_MS = 2 * 60 * 60 * 1_000;
const MIN_COLLECTOR_TIMEOUT_MS = 1;
const MAX_COLLECTOR_TIMEOUT_MS = 60_000;
const DEFAULT_COLLECTOR_TIMEOUT_MS = 10_000;

const DEFAULT_FRESHNESS: Record<string, FreshnessPolicy> = {
  'claude-code': { staleAfterMs: 10 * 60 * 1_000, expireAfterMs: 60 * 60 * 1_000 },
  'openai-codex': { staleAfterMs: 10 * 60 * 1_000, expireAfterMs: 60 * 60 * 1_000 },
  'gemini-cli': { staleAfterMs: 10 * 60 * 1_000, expireAfterMs: 60 * 60 * 1_000 },
  default: { staleAfterMs: 5 * 60 * 1_000, expireAfterMs: 30 * 60 * 1_000 },
};

function defaultCollectors(): ProviderCapacityCollectors {
  return {
    'claude-code': ({ signal }) => claudeUsageService.getCapacityObservation(undefined, signal),
    'openai-codex': ({ signal }) => codexUsageService.getCapacityObservation(undefined, signal),
    'gemini-cli': ({ signal }) => geminiUsageService.getCapacityObservation(undefined, signal),
  };
}

class CapacityCollectorTimeoutError extends Error {}

export class ProviderCapacityService {
  private readonly collectors: ProviderCapacityCollectors;
  private readonly now: () => number;
  private readonly freshness: Partial<Record<string, Partial<FreshnessPolicy>>>;
  private readonly collectorTimeoutMs: number;
  private readonly scheduleTimeout: NonNullable<ProviderCapacityServiceOptions['scheduleTimeout']>;
  private readonly cancelTimeout: NonNullable<ProviderCapacityServiceOptions['cancelTimeout']>;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<RefreshResult>>();
  private nextRevision = 1;

  constructor(options: ProviderCapacityServiceOptions = {}) {
    this.collectors = Object.assign(
      Object.create(null) as ProviderCapacityCollectors,
      options.collectors ?? defaultCollectors(),
    );
    this.now = options.now ?? Date.now;
    this.freshness = options.freshness ?? {};
    this.collectorTimeoutMs = bounded(
      options.collectorTimeoutMs ?? DEFAULT_COLLECTOR_TIMEOUT_MS,
      MIN_COLLECTOR_TIMEOUT_MS,
      MAX_COLLECTOR_TIMEOUT_MS,
    );
    this.scheduleTimeout = options.scheduleTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancelTimeout = options.cancelTimeout ?? ((handle) => clearTimeout(handle));
  }

  async getCapacity(request: ProviderCapacityRequest): Promise<ProviderCapacitySnapshotV1> {
    const key = this.observationKey(request.provider, request.scopeKey);
    const cached = this.cache.get(key);
    if (cached && !request.refresh) {
      return this.toSnapshot(cached, true, request.model);
    }

    const active = this.inflight.get(key);
    if (active) {
      const result = await active;
      return this.toSnapshot(result.entry, result.cacheHit, request.model);
    }

    const refresh = this.refreshCapacity(request, key);
    this.inflight.set(key, refresh);
    try {
      const result = await refresh;
      return this.toSnapshot(result.entry, result.cacheHit, request.model);
    } finally {
      if (this.inflight.get(key) === refresh) this.inflight.delete(key);
    }
  }

  async preflight(
    request: ProviderCapacityRequest,
    options: CapacityPreflightOptions = {},
  ): Promise<CapacityPreflightDecision> {
    return decideProviderCapacity(await this.getCapacity(request), options);
  }

  /**
   * Accept a trusted allowlisted observation, for example a structured hard
   * limit returned by the normal provider launch failure path. This never
   * stores or returns the internal scope key.
   */
  recordObservation(
    observation: ProviderCapacityObservation,
    scopeKey = 'default',
  ): ProviderCapacitySnapshotV1 {
    const key = this.observationKey(observation.provider, scopeKey);
    const entry = this.acceptObservation(key, observation);
    return this.toSnapshot(entry, false, observation.model);
  }

  clear(): void {
    this.cache.clear();
    this.inflight.clear();
  }

  private async refreshCapacity(
    request: ProviderCapacityRequest,
    key: string,
  ): Promise<RefreshResult> {
    const revisionAtStart = this.cache.get(key)?.revision ?? 0;
    const collector = Object.prototype.hasOwnProperty.call(this.collectors, request.provider)
      ? this.collectors[request.provider]
      : undefined;
    let observation: ProviderCapacityObservation;

    if (!collector) {
      observation = unsupportedObservation(request.provider, request.model);
    } else {
      try {
        observation = await this.collectWithTimeout(collector, request);
      } catch (error) {
        observation = collectorErrorObservation(
          request.provider,
          request.model,
          error instanceof CapacityCollectorTimeoutError ? 'timeout' : 'unknown',
        );
      }
    }

    const current = this.cache.get(key);
    if (current && current.revision !== revisionAtStart) {
      return { entry: current, cacheHit: true };
    }

    return { entry: this.acceptObservation(key, observation), cacheHit: false };
  }

  private collectWithTimeout(
    collector: ProviderCapacityCollector,
    request: ProviderCapacityRequest,
  ): Promise<ProviderCapacityObservation> {
    const controller = new AbortController();
    return new Promise((resolve, reject) => {
      let settled = false;
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        if (timeoutHandle !== null) this.cancelTimeout(timeoutHandle);
        callback();
      };
      timeoutHandle = this.scheduleTimeout(() => {
        if (settled) return;
        settled = true;
        controller.abort();
        reject(new CapacityCollectorTimeoutError());
      }, this.collectorTimeoutMs);

      Promise.resolve().then(() => collector({
        provider: request.provider,
        model: undefined,
        scopeKey: request.scopeKey ?? 'default',
        signal: controller.signal,
      })).then(
        (observation) => finish(() => resolve(observation)),
        (error) => finish(() => reject(error)),
      );
    });
  }

  private acceptObservation(
    key: string,
    observation: ProviderCapacityObservation,
  ): CacheEntry {
    const nowMs = this.now();
    const entry: CacheEntry = {
      observation: normalizeObservation(observation),
      receivedAt: new Date(nowMs).toISOString(),
      revision: this.nextRevision++,
    };
    this.cache.set(key, entry);
    return entry;
  }

  private toSnapshot(
    entry: CacheEntry,
    cacheHit: boolean,
    requestedModel?: string,
  ): ProviderCapacitySnapshotV1 {
    const nowMs = this.now();
    const observation = normalizeObservation(entry.observation, requestedModel);
    const policy = this.policyFor(observation.provider);
    const windows = observation.windows.map((window) => ({ ...window }));
    const freshness = computeFreshness(
      observation.observedAt,
      entry.receivedAt,
      windows,
      nowMs,
      policy,
      observation.validForMs,
    );

    return {
      schemaVersion: 1,
      provider: observation.provider,
      ...(observation.model ? { model: observation.model } : {}),
      observationState: observation.observationState,
      capacityState: observation.capacityState,
      observedAt: observation.observedAt,
      receivedAt: entry.receivedAt,
      freshness,
      source: { ...observation.source },
      windows,
      effectiveResetAt: effectiveResetAtForWindows(windows, nowMs),
      error: observation.error ? { ...observation.error } : null,
      cache: { hit: cacheHit },
    };
  }

  private policyFor(provider: ProviderId): FreshnessPolicy {
    const base = Object.prototype.hasOwnProperty.call(DEFAULT_FRESHNESS, provider)
      ? DEFAULT_FRESHNESS[provider]
      : DEFAULT_FRESHNESS.default;
    const override = Object.prototype.hasOwnProperty.call(this.freshness, provider)
      ? this.freshness[provider]
      : undefined;
    const staleAfterMs = bounded(
      override?.staleAfterMs ?? base.staleAfterMs,
      MIN_STALE_AFTER_MS,
      MAX_STALE_AFTER_MS,
    );
    const expireAfterMs = bounded(
      override?.expireAfterMs ?? base.expireAfterMs,
      staleAfterMs,
      MAX_EXPIRE_AFTER_MS,
    );
    return { staleAfterMs, expireAfterMs };
  }

  private observationKey(provider: ProviderId, scopeKey?: string): string {
    return JSON.stringify([
      provider,
      scopeKey ?? 'default',
    ]);
  }
}

function bounded(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.max(minimum, Math.min(maximum, value));
}

function normalizeObservation(
  observation: ProviderCapacityObservation,
  requestedModel?: string,
): ProviderCapacityObservation {
  const observedModel = normalizeCapacityModelId(observation.provider, observation.model);
  const model = normalizeCapacityModelId(
    observation.provider,
    requestedModel ?? observation.model,
  );
  const normalizedWindows = observation.windows
    .map((window) => normalizeWindow(window, observation.provider));
  const windows = applicableCapacityWindows(normalizedWindows, model);
  const hasWindowParseError = normalizedWindows.some(
    (window) => window.evidenceError === 'parse-error',
  );
  const hasApplicableParseError = windows.some(
    (window) => window.evidenceError === 'parse-error',
  );
  const observationState = observation.observationState === 'error'
    && observation.error?.code === 'parse-error'
    && hasWindowParseError
    && !hasApplicableParseError
    ? 'ok'
    : observation.observationState;
  const structuredHardLimit = observation.source.kind === 'provider-error'
    && observation.capacityState === 'exhausted'
    && (!observedModel || !model || observedModel === model)
    && (
      !normalizedWindows.some((window) => window.scope === 'model')
      || windows.some((window) => window.state === 'exhausted')
    );
  const capacityState = observationState === 'ok'
    ? structuredHardLimit ? 'exhausted' : aggregateCapacityState(windows)
    : 'unknown';
  const observedAt = normalizedTimestamp(observation.observedAt);
  const fallbackError = capacityError(
    observationState === 'unsupported'
      ? 'unsupported'
      : observationState === 'unavailable'
        ? 'collector-unavailable'
        : 'unknown',
    observationState !== 'unsupported',
  );
  const error = observationState === 'ok'
    ? null
    : observation.error
      ? capacityError(observation.error.code, observation.error.retryable)
      : fallbackError;

  return {
    provider: observation.provider,
    ...(model ? { model } : {}),
    observationState,
    capacityState,
    observedAt,
    source: normalizeSource(observation.source),
    windows,
    effectiveResetAt: null,
    error,
    validForMs: observation.validForMs ?? null,
  };
}

function normalizeSource(source: CapacitySourceDescriptor): CapacitySourceDescriptor {
  return {
    kind: source.kind,
    confidence: source.confidence,
    collector: source.collector,
    providerReported: source.providerReported === true,
  };
}

function normalizeWindow(window: CapacityWindow, provider: ProviderId): CapacityWindow {
  const usedRatio = validatedRatio(window.usedRatio);
  const remainingRatio = validatedRatio(window.remainingRatio);
  const resetAt = normalizedTimestamp(window.resetAt);
  return {
    id: window.id,
    ...(window.label ? { label: window.label } : {}),
    scope: window.scope,
    ...(window.model ? { model: normalizeCapacityModelId(provider, window.model) } : {}),
    ...(window.modelMatch ? { modelMatch: window.modelMatch } : {}),
    ...(typeof window.routingRelevant === 'boolean'
      ? { routingRelevant: window.routingRelevant }
      : {}),
    ...(window.evidenceError === 'parse-error' ? { evidenceError: 'parse-error' as const } : {}),
    state: window.state,
    usedRatio,
    remainingRatio,
    usedUnits: finiteOrNull(window.usedUnits),
    remainingUnits: finiteOrNull(window.remainingUnits),
    unit: window.unit,
    resetAt,
    resetConfidence: resetAt ? window.resetConfidence : 'unknown',
  };
}

function finiteOrNull(value: number | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function unsupportedObservation(provider: ProviderId, model?: string): ProviderCapacityObservation {
  return {
    provider,
    ...(model ? { model } : {}),
    observationState: 'unsupported',
    capacityState: 'unknown',
    observedAt: null,
    source: {
      kind: 'unsupported',
      confidence: 'none',
      collector: 'none',
      providerReported: false,
    },
    windows: [],
    error: capacityError('unsupported', false),
  };
}

function collectorErrorObservation(
  provider: ProviderId,
  model?: string,
  code: 'timeout' | 'unknown' = 'unknown',
): ProviderCapacityObservation {
  const collector = provider === 'claude-code'
    ? 'ClaudeUsageService'
    : provider === 'openai-codex'
      ? 'CodexUsageService'
      : provider === 'gemini-cli'
        ? 'GeminiUsageService'
        : 'none';
  return {
    provider,
    ...(model ? { model } : {}),
    observationState: 'error',
    capacityState: 'unknown',
    observedAt: null,
    source: {
      kind: provider === 'openai-codex' ? 'provider-cli' : 'provider-response',
      confidence: 'none',
      collector,
      providerReported: false,
    },
    windows: [],
    error: capacityError(code, true),
  };
}

export const providerCapacityService = new ProviderCapacityService();
