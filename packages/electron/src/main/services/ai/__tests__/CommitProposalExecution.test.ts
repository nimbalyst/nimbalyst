// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
const records = vi.hoisted(() => new Map<string, unknown>());
vi.mock("../../../utils/privateSettingsStore", () => ({
  default: class {
    constructor(private options: { name: string }) {}
    get(key: string) {
      return records.get(this.options.name + key);
    }
    set(key: string, value: unknown) {
      records.set(this.options.name + key, value);
    }
  },
}));
import {
  runCommitProposalOnce,
  cancelCommitProposalOnce,
  acceptsCommitProposalResponse,
} from "../CommitProposalExecution";
import { reservePromptAnswer } from "../PromptAnswerReservation";
beforeEach(() => {
  records.clear();
});
describe("shared card and voice answer boundary", () => {
  it("reserves a commit before awaiting Git, retains the real failure, and blocks cancellation/replay", async () => {
    let finish!: () => void;
    const execute = vi.fn(async () => {
      await new Promise<void>((r) => {
        finish = r;
      });
      return { success: false, error: "hook failed" };
    });
    const first = runCommitProposalOnce("s", "p", "selection", execute);
    expect(await cancelCommitProposalOnce("s", "p")).toBe(false);
    expect(
      acceptsCommitProposalResponse("s", "p", {
        action: "error",
        error: "Already executing",
      })
    ).toBe(false);
    expect(
      (await runCommitProposalOnce("s", "p", "selection", execute)).success
    ).toBe(false);
    finish();
    expect(await first).toEqual({ success: false, error: "hook failed" });
    expect(
      acceptsCommitProposalResponse("s", "p", {
        action: "error",
        error: "hook failed",
      })
    ).toBe(true);
    expect(
      acceptsCommitProposalResponse("s", "p", { action: "cancelled" })
    ).toBe(false);
    expect(await runCommitProposalOnce("s", "p", "selection", execute)).toEqual(
      { success: false, error: "hook failed" }
    );
    expect(execute).toHaveBeenCalledOnce();
    expect(await cancelCommitProposalOnce("s", "other")).toBe(true);
    expect(
      (await runCommitProposalOnce("s", "other", "selection", execute)).success
    ).toBe(false);
  });
  it("allows UI persistence then delivery, rejecting a competing answer and repeated dispatch", async () => {
    const yes = { decision: "allow", scope: "once" };
    expect(reservePromptAnswer("s", "permission", "p", yes, "record")).toBe(
      true
    );
    expect(
      reservePromptAnswer("s", "permission", "p", { decision: "deny" })
    ).toBe(false);
    expect(reservePromptAnswer("s", "permission", "p", yes)).toBe(true);
    expect(reservePromptAnswer("s", "permission", "p", yes)).toBe(false);
    vi.resetModules();
    const restarted = await import("../PromptAnswerReservation");
    expect(restarted.reservePromptAnswer("s", "permission", "p", yes)).toBe(
      false
    );
    const answer = { answers: { Scope: "This file" } };
    expect(reservePromptAnswer("s", "question", "q", answer)).toBe(true);
    expect(
      reservePromptAnswer(
        "s",
        "question",
        "q",
        { answers: { Scope: "Everything" } },
        "record"
      )
    ).toBe(false);
    expect(reservePromptAnswer("other-session", "question", "q", answer)).toBe(
      true
    );
  });
});
