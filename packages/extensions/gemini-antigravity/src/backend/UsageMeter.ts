/**
 * AntigravityUsageMeter (backend module).
 *
 * Direct port of packages/runtime/.../antigravity/AntigravityUsageMeter.ts with
 * the import path repointed at the local ServerManager. Reads usage/quota for
 * the Antigravity-backed Gemini models so the UI can warn before rate-limiting.
 *
 * Two complementary signals from GetUserStatus:
 *   - account-level credits (prompt/flow) + plan tier
 *   - per-model quota: remainingFraction (0..1) + resetTime (ISO8601 UTC)
 */
import { AntigravityServerManager } from './ServerManager';

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

export interface AntigravityUsageSnapshot {
  account: AntigravityAccountUsage;
  /** Per-model quotas keyed by enum. */
  models: Record<string, AntigravityModelQuota>;
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

  /** One call returning account usage + all per-model quotas + a warn flag. */
  async getSnapshot(): Promise<AntigravityUsageSnapshot> {
    const us = await this.server.getUserStatus();
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

    const lowCredits = isLowCredit(account.availablePromptCredits, account.monthlyPromptCredits)
      || isLowCredit(account.availableFlowCredits, account.monthlyFlowCredits);

    return { account, models, warn: lowFraction || lowCredits };
  }
}

function isLowCredit(available?: number, monthly?: number): boolean {
  if (typeof available !== 'number' || typeof monthly !== 'number' || monthly <= 0) {
    return false;
  }
  return available < monthly * LOW_CREDIT_FRACTION;
}
