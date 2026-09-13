/**
 * The review plan the user approves before anything is created in their
 * Cloudflare account.
 *
 * The plan id is not a random handle. It is a digest of everything the plan
 * asserts: the profile, the account, the artifact contents, the container
 * sizing, and the resource list. That makes staleness detectable without
 * trusting the renderer — `deploy` recomputes the id from current state and
 * refuses if it differs from the one the user approved.
 *
 * So an approved plan cannot be replayed against a different account (the
 * account is in the digest), and an artifact swapped underneath an open panel
 * invalidates the approval rather than silently deploying something else.
 */

import { createHash } from "crypto";

import type {
  CloudflareAccount,
  DeploymentPlan,
  PlannedContainerConfig,
  PlannedResource,
} from "../../../shared/cloudflareSandbox";
import type { ArtifactAvailability } from "./artifactProvider";
import { SandboxOperationError } from "./errors";
import { containerApplicationName } from "./workerConfig";

/** Fixed identity of the single sandbox this version manages. */
export const SANDBOX_ID = "personal";

export interface PlanInputs {
  profileName: string;
  account: CloudflareAccount;
  workerName: string;
  imageRef: string;
  container: PlannedContainerConfig;
  contentHash: string;
  /** True when the account already has a Worker by this name. */
  workerExists: boolean;
}

/** Digest of everything the plan promises. Pure, so tests can pin it. */
export function computePlanId(inputs: PlanInputs): string {
  const canonical = JSON.stringify([
    "cloudflare-sandbox-plan-v2",
    inputs.profileName,
    inputs.account.id,
    inputs.workerName,
    inputs.imageRef,
    inputs.contentHash,
    inputs.container.instanceType,
    inputs.container.maxInstances,
    inputs.container.sleepAfterMinutes,
    inputs.workerExists,
  ]);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

export function buildPlan(inputs: PlanInputs): DeploymentPlan {
  const action: PlannedResource["action"] = inputs.workerExists
    ? "update"
    : "create";
  return {
    planId: computePlanId(inputs),
    profileName: inputs.profileName,
    account: inputs.account,
    resources: [
      { kind: "Worker", name: inputs.workerName, action },
      {
        kind: "Durable Object namespace",
        name: `${inputs.workerName}: NimbalystSandbox`,
        action,
      },
      // Listed separately from the Worker because it is deleted separately;
      // the review should show everything delete will have to remove.
      {
        kind: "Container application",
        name: containerApplicationName(inputs.workerName),
        action,
      },
      { kind: "Container image", name: inputs.imageRef, action: "reuse" },
    ],
    container: inputs.container,
    costNotes: buildCostNotes(inputs.container),
    requiresPaidPlan: true,
  };
}

/**
 * Wording is owned here because the renderer prints it verbatim, and it is part
 * of the plan digest, so changing it invalidates a pending approval.
 *
 * Every claim below is taken from Cloudflare's Containers pricing page. The one
 * dollar figure is the Workers Paid subscription, which is fixed and published;
 * there is deliberately no estimate of what a session will cost, because that
 * depends on the user's workload and a made-up number here would be read as a
 * promise.
 */
function buildCostNotes(container: PlannedContainerConfig): string[] {
  return [
    "Containers require the Workers Paid plan, which is $5/month. Deploying on a free account will fail.",
    `The ${container.instanceType} container is billed for every 10ms it is actively running. CPU is charged on active use, while memory and disk are charged on the resources provisioned for the instance type, so they accrue whenever the container is running rather than only when it is busy.`,
    "Workers and Durable Objects are billed separately from the container, because requests reach the sandbox through a Worker and each container has its own Durable Object.",
    `Nimbalyst limits this to ${container.maxInstances} container instance and sleeps it after ${container.sleepAfterMinutes} minutes idle. That bounds how fast charges accrue; it is not a spending cap, so check your Cloudflare billing.`,
  ];
}

/**
 * In-memory record of plans handed to the renderer. Not persisted: a plan is
 * only valid for the app session that produced it, and an approval that
 * survived a restart would be an approval of state nobody re-checked.
 */
export class PlanRegistry {
  #plans = new Map<string, DeploymentPlan>();

  remember(plan: DeploymentPlan): DeploymentPlan {
    this.#plans.set(plan.planId, plan);
    return plan;
  }

  /**
   * Return the approved plan, or throw `plan-stale`.
   *
   * Three ways to be stale, all of which must fail identically from the user's
   * side: the id was never issued, the id was issued for a different
   * profile/account than the deploy request names, or the world moved and the
   * recomputed digest no longer matches.
   */
  requireCurrent(
    planId: string,
    request: { profileName: string; accountId: string },
    recomputed: PlanInputs
  ): DeploymentPlan {
    const plan = this.#plans.get(planId);
    if (!plan) {
      throw new SandboxOperationError("plan-stale", "plan-lookup");
    }
    if (
      plan.profileName !== request.profileName ||
      plan.account.id !== request.accountId
    ) {
      throw new SandboxOperationError("plan-stale", "plan-target-mismatch");
    }
    if (computePlanId(recomputed) !== planId) {
      throw new SandboxOperationError("plan-stale", "plan-digest-mismatch");
    }
    return plan;
  }

  forget(planId: string): void {
    this.#plans.delete(planId);
  }

  clear(): void {
    this.#plans.clear();
  }
}

/** Narrow an availability result to the available case, or throw. */
export function requireAvailableArtifact(
  availability: ArtifactAvailability
): Extract<ArtifactAvailability, { available: true }> {
  if (!availability.available) {
    // The provider's reason is authored by us for the user, so it is rendered
    // rather than replaced by the generic deploy-failure wording. Telling the
    // user "Wrangler could not complete the deployment" when the real answer is
    // "this build ships no Worker" would send them debugging their account.
    throw new SandboxOperationError(
      "deploy-failed",
      "artifact-unavailable",
      availability.reason
    );
  }
  return availability;
}
