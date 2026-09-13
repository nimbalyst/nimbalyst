// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { PlannedContainerConfig } from "../../../../shared/cloudflareSandbox";
import {
  buildPlan,
  computePlanId,
  PlanRegistry,
  requireAvailableArtifact,
  type PlanInputs,
} from "../deploymentPlan";
import { SandboxOperationError } from "../errors";

const container: PlannedContainerConfig = {
  instanceType: "standard-3",
  maxInstances: 1,
  sleepAfterMinutes: 5,
};

function inputs(overrides: Partial<PlanInputs> = {}): PlanInputs {
  return {
    profileName: "work",
    account: { id: "acct-1", name: "Work Account" },
    workerName: "nimbalyst-sandbox",
    imageRef: "docker.io/nimbalyst/sandbox:1.0.0",
    container,
    contentHash: "hash-a",
    workerExists: false,
    ...overrides,
  };
}

describe("computePlanId", () => {
  it("changes when the account changes, so an approved plan cannot be replayed elsewhere", () => {
    const first = computePlanId(inputs());
    const second = computePlanId(
      inputs({ account: { id: "acct-2", name: "Other Account" } })
    );

    expect(second).not.toBe(first);
  });

  it("changes when the artifact contents change under an open review", () => {
    expect(computePlanId(inputs({ contentHash: "hash-b" }))).not.toBe(
      computePlanId(inputs())
    );
  });

  it("changes when container sizing changes, since that is what the user is approving the cost of", () => {
    expect(
      computePlanId(
        inputs({ container: { ...container, instanceType: "standard-4" } })
      )
    ).not.toBe(computePlanId(inputs()));
  });

  it("is stable for identical inputs", () => {
    expect(computePlanId(inputs())).toBe(computePlanId(inputs()));
  });
});

describe("buildPlan", () => {
  it("reports create for a first deploy and update when the worker already exists", () => {
    expect(buildPlan(inputs()).resources[0]).toMatchObject({
      kind: "Worker",
      action: "create",
    });
    expect(
      buildPlan(inputs({ workerExists: true })).resources[0]
    ).toMatchObject({
      action: "update",
    });
  });

  it("names the container application, since delete has to remove it separately from the worker", () => {
    expect(buildPlan(inputs()).resources).toContainEqual({
      kind: "Container application",
      name: "nimbalyst-sandbox-nimbalystsandbox",
      action: "create",
    });
  });

  it("always requires a paid plan and says so in the cost notes", () => {
    const plan = buildPlan(inputs());

    expect(plan.requiresPaidPlan).toBe(true);
    expect(plan.costNotes.join(" ")).toContain("Workers Paid");
  });

  it("describes billing the way Cloudflare does, not as a per-minute estimate", () => {
    const notes = buildPlan(inputs()).costNotes.join(" ");

    expect(notes).toMatch(/10ms/);
    expect(notes).toMatch(/provisioned/i);
    expect(notes).toMatch(/Workers and Durable Objects are billed separately/i);
    // Per-minute was wrong, and a made-up hourly figure would be read as a promise.
    expect(notes).not.toMatch(/per minute|\$0\.\d/i);
  });

  it("does not present the instance and sleep limits as a spending cap", () => {
    const notes = buildPlan(inputs()).costNotes.join(" ");

    expect(notes).toMatch(/not a spending cap/i);
  });
});

describe("PlanRegistry.requireCurrent", () => {
  it("rejects a planId that was never issued", () => {
    const registry = new PlanRegistry();

    expect(() =>
      registry.requireCurrent(
        "never-issued",
        { profileName: "work", accountId: "acct-1" },
        inputs()
      )
    ).toThrow(SandboxOperationError);
  });

  it("rejects a deploy that names a different account than the approved plan", () => {
    const registry = new PlanRegistry();
    const plan = registry.remember(buildPlan(inputs()));

    expect(() =>
      registry.requireCurrent(
        plan.planId,
        { profileName: "work", accountId: "acct-2" },
        inputs({ account: { id: "acct-2", name: "Other Account" } })
      )
    ).toThrow(/plan/i);
  });

  it("rejects a deploy when the artifact changed after the user approved the plan", () => {
    const registry = new PlanRegistry();
    const plan = registry.remember(buildPlan(inputs()));

    expect(() =>
      registry.requireCurrent(
        plan.planId,
        { profileName: "work", accountId: "acct-1" },
        inputs({ contentHash: "rebuilt" })
      )
    ).toThrow(SandboxOperationError);
  });

  it("accepts a deploy whose recomputed state still matches the approval", () => {
    const registry = new PlanRegistry();
    const plan = registry.remember(buildPlan(inputs()));

    expect(
      registry.requireCurrent(
        plan.planId,
        { profileName: "work", accountId: "acct-1" },
        inputs()
      ).planId
    ).toBe(plan.planId);
  });

  it("stops accepting a plan once it has been consumed", () => {
    const registry = new PlanRegistry();
    const plan = registry.remember(buildPlan(inputs()));
    registry.forget(plan.planId);

    expect(() =>
      registry.requireCurrent(
        plan.planId,
        { profileName: "work", accountId: "acct-1" },
        inputs()
      )
    ).toThrow(SandboxOperationError);
  });
});

describe("requireAvailableArtifact", () => {
  it("surfaces the provider's own reason to the user instead of a generic deploy failure", () => {
    let thrown: SandboxOperationError | null = null;
    try {
      requireAvailableArtifact({
        available: false,
        reason: "This build does not include the sandbox Worker image yet.",
      });
    } catch (error) {
      thrown = error as SandboxOperationError;
    }

    expect(thrown?.userMessage).toBe(
      "This build does not include the sandbox Worker image yet."
    );
  });
});
