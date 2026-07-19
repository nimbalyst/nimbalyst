export type ProviderId = 'claude-code' | 'openai-codex' | 'gemini-cli' | string;

export type ObservationState = 'ok' | 'unsupported' | 'unavailable' | 'error';
export type CapacityState = 'available' | 'limited' | 'exhausted' | 'unknown';
export type FreshnessState = 'fresh' | 'stale' | 'expired' | 'unknown';
export type Confidence = 'high' | 'medium' | 'low' | 'none';

export type CapacitySource =
  | 'provider-response'
  | 'provider-cli'
  | 'local-cache'
  | 'provider-error'
  | 'unsupported';

export type CapacityCollector =
  | 'ClaudeUsageService'
  | 'CodexUsageService'
  | 'GeminiUsageService'
  | 'none';

export interface CapacityWindow {
  id: string;
  label?: string;
  scope: 'account' | 'provider' | 'model' | 'session' | 'unknown';
  /** Canonical provider:model identifier when scope is model. */
  model?: string;
  /** Family matching is reserved for provider-reported family buckets such as Claude Opus. */
  modelMatch?: 'exact' | 'family';
  /** False only when the provider explicitly proves this window cannot constrain routing. */
  routingRelevant?: boolean;
  /** Redacted validation category used to scope malformed evidence to applicable views. */
  evidenceError?: 'parse-error';
  state: CapacityState;
  usedRatio: number | null;
  remainingRatio: number | null;
  usedUnits: number | null;
  remainingUnits: number | null;
  unit: 'tokens' | 'requests' | 'currency' | 'percent' | 'unknown';
  resetAt: string | null;
  resetConfidence: 'provider-reported' | 'derived' | 'unknown';
}

export interface CapacityObservationError {
  code:
    | 'auth-required'
    | 'provider-unreachable'
    | 'rate-limited'
    | 'timeout'
    | 'parse-error'
    | 'collector-unavailable'
    | 'unsupported'
    | 'unknown';
  retryable: boolean;
  redactedMessage?: string;
}

export interface CapacitySourceDescriptor {
  kind: CapacitySource;
  confidence: Confidence;
  collector: CapacityCollector;
  providerReported: boolean;
}

/**
 * Internal, allowlisted result produced by a provider adapter. Raw provider
 * payloads and auth-profile identifiers must never be stored in this shape.
 */
export interface ProviderCapacityObservation {
  provider: ProviderId;
  model?: string;
  observationState: ObservationState;
  capacityState: CapacityState;
  observedAt: string | null;
  source: CapacitySourceDescriptor;
  windows: CapacityWindow[];
  effectiveResetAt?: string | null;
  error: CapacityObservationError | null;
  /** A provider-supplied validity period. It can only shorten configured freshness. */
  validForMs?: number | null;
}

export interface ProviderCapacitySnapshotV1 {
  schemaVersion: 1;
  provider: ProviderId;
  model?: string;
  observationState: ObservationState;
  capacityState: CapacityState;
  observedAt: string | null;
  receivedAt: string;
  freshness: {
    state: FreshnessState;
    ageMs: number | null;
    staleAfterMs: number | null;
    expiresAt: string | null;
  };
  source: CapacitySourceDescriptor;
  windows: CapacityWindow[];
  effectiveResetAt: string | null;
  error: CapacityObservationError | null;
  cache: {
    hit: boolean;
  };
}

export type CapacityPreflightReason =
  | 'fresh-capacity'
  | 'fresh-limited'
  | 'known-hard-limit'
  | 'known-hard-limit-until-reset'
  | 'stale-observation'
  | 'unsupported-source'
  | 'provider-unavailable'
  | 'observation-error'
  | 'no-capacity-evidence';

export interface CapacityPreflightDecision {
  verdict: 'allow' | 'avoid' | 'defer' | 'block' | 'indeterminate';
  reason: CapacityPreflightReason;
  retryAt: string | null;
  snapshot: ProviderCapacitySnapshotV1;
}

export type CapacityPreflightPolicy = 'best-effort' | 'require-fresh';

export interface CapacityPreflightOptions {
  policy?: CapacityPreflightPolicy;
  healthierAlternativeAvailable?: boolean;
}

export interface FreshnessPolicy {
  staleAfterMs: number;
  expireAfterMs: number;
}

const FIXED_ERROR_MESSAGES: Record<CapacityObservationError['code'], string> = {
  'auth-required': 'Provider authentication is required.',
  'provider-unreachable': 'The provider capacity source is unreachable.',
  'rate-limited': 'The provider capacity source is rate limited.',
  timeout: 'The provider capacity observation timed out.',
  'parse-error': 'The provider capacity response could not be validated.',
  'collector-unavailable': 'The provider capacity collector is unavailable.',
  unsupported: 'This provider does not expose supported capacity data.',
  unknown: 'The provider capacity observation failed.',
};

export function capacityError(
  code: CapacityObservationError['code'],
  retryable: boolean,
): CapacityObservationError {
  return { code, retryable, redactedMessage: FIXED_ERROR_MESSAGES[code] };
}

export function ratioFromPercent(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
    return null;
  }
  return value / 100;
}

export function validatedRatio(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    return null;
  }
  return value;
}

export function normalizedTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

export function stateFromRemainingRatio(remainingRatio: number | null): CapacityState {
  if (remainingRatio === null) return 'unknown';
  if (remainingRatio === 0) return 'exhausted';
  if (remainingRatio <= 0.2) return 'limited';
  return 'available';
}

export function stateFromUsedRatio(usedRatio: number | null): CapacityState {
  return usedRatio === null ? 'unknown' : stateFromRemainingRatio(1 - usedRatio);
}

export function normalizeCapacityModelId(
  provider: ProviderId,
  model: string | null | undefined,
): string | undefined {
  if (typeof model !== 'string') return undefined;
  const trimmed = model.trim();
  if (!trimmed) return undefined;
  const separator = trimmed.indexOf(':');
  const providerModel = (separator >= 0 ? trimmed.slice(separator + 1) : trimmed).trim();
  if (!providerModel) return undefined;
  return `${provider}:${providerModel.toLowerCase()}`;
}

export function capacityModelMatches(window: CapacityWindow, requestedModel: string): boolean {
  if (!window.model) return false;
  if (window.model === requestedModel) return true;
  if (window.modelMatch !== 'family') return false;
  const familySeparator = window.model.indexOf(':');
  const requestedSeparator = requestedModel.indexOf(':');
  if (familySeparator < 0 || requestedSeparator < 0) return false;
  if (window.model.slice(0, familySeparator) !== requestedModel.slice(0, requestedSeparator)) {
    return false;
  }
  const family = window.model.slice(familySeparator + 1);
  const requestedParts = requestedModel.slice(requestedSeparator + 1).split(/[-_.:\[\]]+/);
  return requestedParts.includes(family);
}

export function applicableCapacityWindows(
  windows: CapacityWindow[],
  requestedModel: string | undefined,
): CapacityWindow[] {
  if (requestedModel === undefined) return windows;
  return windows.filter((window) => {
    if (window.scope !== 'model') return true;
    return capacityModelMatches(window, requestedModel);
  });
}

export function aggregateCapacityState(windows: CapacityWindow[]): CapacityState {
  const relevant = windows.filter((window) => window.routingRelevant !== false);
  if (relevant.some((window) => window.state === 'exhausted')) return 'exhausted';
  if (relevant.some((window) => window.state === 'limited')) return 'limited';
  if (relevant.some((window) => window.state === 'unknown')) return 'unknown';
  if (relevant.some((window) => window.state === 'available')) return 'available';
  return 'unknown';
}

export function effectiveResetAtForWindows(
  windows: CapacityWindow[],
  nowMs: number,
): string | null {
  const resetTimes = windows
    .filter((window) =>
      window.routingRelevant !== false
      && (window.state === 'limited' || window.state === 'exhausted')
      && window.resetConfidence === 'provider-reported')
    .map((window) => window.resetAt)
    .filter((resetAt): resetAt is string => resetAt !== null)
    .map((resetAt) => ({ resetAt, timestamp: Date.parse(resetAt) }))
    .filter(({ timestamp }) => Number.isFinite(timestamp) && timestamp > nowMs)
    .sort((a, b) => a.timestamp - b.timestamp);
  return resetTimes[0]?.resetAt ?? null;
}

export function computeFreshness(
  observedAt: string | null,
  receivedAt: string,
  windows: CapacityWindow[],
  nowMs: number,
  policy: FreshnessPolicy,
  validForMs?: number | null,
): ProviderCapacitySnapshotV1['freshness'] {
  const observedMs = observedAt === null ? Number.NaN : Date.parse(observedAt);
  const receivedMs = Date.parse(receivedAt);
  if (
    !Number.isFinite(observedMs)
    || !Number.isFinite(receivedMs)
    || observedMs > receivedMs
    || nowMs < observedMs
    || nowMs < receivedMs
  ) {
    return { state: 'unknown', ageMs: null, staleAfterMs: null, expiresAt: null };
  }

  const sourceStaleAfter = typeof validForMs === 'number' && Number.isFinite(validForMs) && validForMs >= 0
    ? validForMs
    : policy.staleAfterMs;
  const staleAfterMs = Math.min(policy.staleAfterMs, sourceStaleAfter);
  const expireAfterMs = Math.max(staleAfterMs, policy.expireAfterMs);
  const expiresAt = new Date(observedMs + expireAfterMs).toISOString();
  const ageMs = nowMs - observedMs;

  const constrainingResetCrossed = windows.some((window) => {
    if (window.routingRelevant === false) return false;
    if (window.state !== 'limited' && window.state !== 'exhausted') return false;
    if (window.resetConfidence !== 'provider-reported') return false;
    if (window.resetAt === null) return false;
    const resetMs = Date.parse(window.resetAt);
    return Number.isFinite(resetMs) && resetMs <= nowMs;
  });

  if (constrainingResetCrossed || ageMs >= expireAfterMs) {
    return { state: 'expired', ageMs, staleAfterMs, expiresAt };
  }
  if (ageMs >= staleAfterMs) {
    return { state: 'stale', ageMs, staleAfterMs, expiresAt };
  }
  return { state: 'fresh', ageMs, staleAfterMs, expiresAt };
}

function strictVerdict(
  verdict: CapacityPreflightDecision['verdict'],
  policy: CapacityPreflightPolicy,
): CapacityPreflightDecision['verdict'] {
  return policy === 'require-fresh' && verdict === 'indeterminate' ? 'block' : verdict;
}

export function decideProviderCapacity(
  snapshot: ProviderCapacitySnapshotV1,
  options: CapacityPreflightOptions = {},
): CapacityPreflightDecision {
  const policy = options.policy ?? 'best-effort';

  if (snapshot.freshness.state !== 'fresh') {
    if (
      (snapshot.freshness.state === 'stale' || snapshot.freshness.state === 'expired')
      && snapshot.capacityState === 'exhausted'
      && snapshot.effectiveResetAt !== null
    ) {
      return {
        verdict: policy === 'require-fresh' ? 'block' : 'defer',
        reason: 'stale-observation',
        retryAt: snapshot.effectiveResetAt,
        snapshot,
      };
    }

    const reason: CapacityPreflightReason = snapshot.freshness.state === 'stale'
      || snapshot.freshness.state === 'expired'
      ? 'stale-observation'
      : observationReason(snapshot);
    return {
      verdict: strictVerdict('indeterminate', policy),
      reason,
      retryAt: null,
      snapshot,
    };
  }

  if (snapshot.observationState !== 'ok') {
    return {
      verdict: strictVerdict('indeterminate', policy),
      reason: observationReason(snapshot),
      retryAt: null,
      snapshot,
    };
  }

  if (snapshot.capacityState === 'exhausted') {
    return {
      verdict: 'block',
      reason: snapshot.effectiveResetAt ? 'known-hard-limit-until-reset' : 'known-hard-limit',
      retryAt: snapshot.effectiveResetAt,
      snapshot,
    };
  }

  if (snapshot.capacityState === 'limited') {
    return {
      verdict: options.healthierAlternativeAvailable ? 'avoid' : 'allow',
      reason: 'fresh-limited',
      retryAt: null,
      snapshot,
    };
  }

  if (snapshot.capacityState === 'available') {
    return { verdict: 'allow', reason: 'fresh-capacity', retryAt: null, snapshot };
  }

  return {
    verdict: strictVerdict('indeterminate', policy),
    reason: 'no-capacity-evidence',
    retryAt: null,
    snapshot,
  };
}

function observationReason(snapshot: ProviderCapacitySnapshotV1): CapacityPreflightReason {
  switch (snapshot.observationState) {
    case 'unsupported':
      return 'unsupported-source';
    case 'unavailable':
      return 'provider-unavailable';
    case 'error':
      return 'observation-error';
    case 'ok':
      return 'no-capacity-evidence';
  }
}
