/**
 * AntigravityUsageMeter.
 *
 * Reads usage/quota for the Antigravity-backed Gemini models so the UI can warn
 * before rate-limiting. Two complementary signals from GetUserStatus:
 *   - account-level credits (prompt/flow) + plan tier
 *   - per-model quota: remainingFraction (0..1) + resetTime (ISO8601 UTC)
 *
 * This is a QUOTA meter, not a token meter. GetModelResponse returns only
 * `{ response }` -- no input/output token counts and no context-window fill --
 * which is why the provider declares `contextReporting: 'none'` rather than
 * drawing a percentage it cannot measure (#914).
 */
import { AntigravityServerManager, type AntigravityEndpoint } from './AntigravityServerManager';

export interface AntigravityAccountUsage {
  name?: string;
  email?: string;
  tier?: string;            // e.g. "TEAMS_TIER_PRO"
  planName?: string;        // e.g. "Pro"
  monthlyPromptCredits?: number;
  monthlyFlowCredits?: number;
  availablePromptCredits?: number;
  availableFlowCredits?: number;
}

export interface AntigravityModelQuota {
  model: string;              // enum
  label?: string;             // e.g. "Gemini 3.5 Flash (High)"
  remainingFraction?: number; // 0..1
  resetTime?: string;         // ISO8601 UTC
}

export interface AntigravityQuotaBucket {
  bucketId: string;           // e.g. "gemini-5h", "gemini-weekly"
  displayName?: string;       // e.g. "Five Hour Limit Remaining"
  window?: string;            // e.g. "5h" | "weekly"
  remainingFraction?: number; // 0..1
  resetTime?: string;         // ISO8601 UTC
  disabled?: boolean;
}

export interface AntigravityQuotaGroup {
  displayName: string;        // e.g. "Gemini Models"
  description?: string;
  buckets: AntigravityQuotaBucket[];
}

export interface AntigravityQuotaSummary {
  description?: string;
  groups: AntigravityQuotaGroup[];
}

export interface AntigravityUsageSnapshot {
  account: AntigravityAccountUsage;
  /** Per-model quotas keyed by enum. */
  models: Record<string, AntigravityModelQuota>;
  /** Grouped 5-hour / weekly quota pools from RetrieveUserQuotaSummary, when supported. */
  quotaSummary?: AntigravityQuotaSummary;
  /** True if any low-quota condition is met (for a warning badge). */
  warn: boolean;
}

/** Warn thresholds. */
const LOW_FRACTION = 0.10;
const LOW_CREDIT_FRACTION = 0.10;

export class AntigravityUsageMeter {
  constructor(
    private readonly server: AntigravityServerManager = AntigravityServerManager.shared(),
  ) {}

  /** Account-level usage (plan tier + remaining credits). */
  async getUsage(): Promise<AntigravityAccountUsage> {
    const us = await this.server.getUserStatus();
    const plan = us?.planStatus ?? {};
    const pi = plan?.planInfo ?? {};
    return {
      name: us?.name,
      email: us?.email,
      tier: pi?.teamsTier,
      planName: pi?.planName,
      monthlyPromptCredits: pi?.monthlyPromptCredits,
      monthlyFlowCredits: pi?.monthlyFlowCredits,
      availablePromptCredits: plan?.availablePromptCredits,
      availableFlowCredits: plan?.availableFlowCredits,
    };
  }

  /**
   * Per-model quota. `modelKeyOrEnum` may be a stable key (resolved to the
   * live enum) or an enum. Returns null if the model is not in the user's
   * config.
   */
  async getQuota(modelKeyOrEnum: string): Promise<AntigravityModelQuota | null> {
    const enumName = modelKeyOrEnum.startsWith('MODEL_')
      ? modelKeyOrEnum
      : await this.server.resolveModelEnum(modelKeyOrEnum).catch(() => modelKeyOrEnum);
    const us = await this.server.getUserStatus();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cfgs: any[] = us?.cascadeModelConfigData?.clientModelConfigs ?? [];
    for (const c of cfgs) {
      if (c?.modelOrAlias?.model === enumName) {
        const q = c?.quotaInfo ?? {};
        return {
          model: enumName,
          label: c?.label,
          remainingFraction: q?.remainingFraction,
          resetTime: q?.resetTime,
        };
      }
    }
    return null;
  }

  /**
   * One call returning account usage + all per-model quotas + grouped
   * 5-hour/weekly quota summary (when supported by the server) + a warn flag.
   * Pass `ep` to read from that endpoint only; without it the read goes
   * through ensureRunning(), which may spawn a language server.
   */
  async getSnapshot(ep?: AntigravityEndpoint): Promise<AntigravityUsageSnapshot> {
    const [us, rawSummary] = await Promise.all([
      this.server.getUserStatus(ep),
      typeof this.server.getUserQuotaSummary === 'function'
        ? this.server.getUserQuotaSummary(ep).catch(() => null)
        : Promise.resolve(null),
    ]);
    const plan = us?.planStatus ?? {};
    const pi = plan?.planInfo ?? {};
    const account: AntigravityAccountUsage = {
      name: us?.name,
      email: us?.email,
      tier: pi?.teamsTier,
      planName: pi?.planName,
      monthlyPromptCredits: pi?.monthlyPromptCredits,
      monthlyFlowCredits: pi?.monthlyFlowCredits,
      availablePromptCredits: plan?.availablePromptCredits,
      availableFlowCredits: plan?.availableFlowCredits,
    };

    const models: Record<string, AntigravityModelQuota> = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cfgs: any[] = us?.cascadeModelConfigData?.clientModelConfigs ?? [];
    let lowFraction = false;
    for (const c of cfgs) {
      const enumName = c?.modelOrAlias?.model;
      if (!enumName) continue;
      const q = c?.quotaInfo ?? {};
      models[enumName] = {
        model: enumName,
        label: c?.label,
        remainingFraction: q?.remainingFraction,
        resetTime: q?.resetTime,
      };
      if (typeof q?.remainingFraction === 'number' && q.remainingFraction < LOW_FRACTION) {
        lowFraction = true;
      }
    }

    const quotaSummary = parseQuotaSummary(rawSummary);
    if (quotaSummary) {
      for (const group of quotaSummary.groups) {
        for (const bucket of group.buckets) {
          if (
            !bucket.disabled &&
            typeof bucket.remainingFraction === 'number' &&
            bucket.remainingFraction < LOW_FRACTION
          ) {
            lowFraction = true;
          }
        }
      }
    }

    const lowCredits = isLowCredit(account.availablePromptCredits, account.monthlyPromptCredits)
      || isLowCredit(account.availableFlowCredits, account.monthlyFlowCredits);

    return {
      account,
      models,
      ...(quotaSummary ? { quotaSummary } : {}),
      warn: lowFraction || lowCredits,
    };
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseQuotaSummary(raw: any): AntigravityQuotaSummary | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawGroups: any[] = Array.isArray(raw.groups) ? raw.groups : [];
  const groups: AntigravityQuotaGroup[] = [];
  for (const g of rawGroups) {
    if (!g || typeof g !== 'object') continue;
    const rawDisplayName = typeof g.displayName === 'string' && g.displayName.trim()
      ? g.displayName.trim()
      : typeof g.name === 'string' && g.name.trim()
        ? g.name.trim()
        : '';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawBuckets: any[] = Array.isArray(g.buckets) ? g.buckets : [];
    const buckets: AntigravityQuotaBucket[] = [];
    for (const b of rawBuckets) {
      if (!b || typeof b !== 'object') continue;
      const bucketId = typeof b.bucketId === 'string' && b.bucketId.trim()
        ? b.bucketId.trim()
        : typeof b.id === 'string' && b.id.trim()
          ? b.id.trim()
          : '';
      if (!bucketId) continue;
      const remainingFraction = typeof b.remainingFraction === 'number'
        ? b.remainingFraction
        : typeof b.remaining?.remainingFraction === 'number'
          ? b.remaining.remainingFraction
          : undefined;
      buckets.push({
        bucketId,
        displayName: typeof b.displayName === 'string' ? b.displayName : typeof b.name === 'string' ? b.name : undefined,
        window: typeof b.window === 'string' ? b.window : undefined,
        remainingFraction,
        resetTime: typeof b.resetTime === 'string' ? b.resetTime : undefined,
        disabled: Boolean(b.disabled),
      });
    }
    if (buckets.length > 0) {
      groups.push({
        displayName: rawDisplayName || 'Quota',
        description: typeof g.description === 'string' ? g.description : undefined,
        buckets,
      });
    }
  }
  if (groups.length === 0) return undefined;
  return {
    description: typeof raw.description === 'string' ? raw.description : undefined,
    groups,
  };
}

function isLowCredit(available?: number, monthly?: number): boolean {
  if (typeof available !== 'number' || typeof monthly !== 'number' || monthly <= 0) {
    return false;
  }
  return available < monthly * LOW_CREDIT_FRACTION;
}
