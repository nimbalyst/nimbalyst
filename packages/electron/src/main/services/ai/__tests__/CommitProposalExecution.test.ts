// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
const records = vi.hoisted(() => new Map<string, unknown>());
const writes = vi.hoisted(() => ({ failResults: false }));
vi.mock("../../../utils/privateSettingsStore", () => ({
  default: class {
    constructor(private options: { name: string }) {}
    get(key: string) {
      return records.get(this.options.name + key);
    }
    set(key: string, value: any) {
      if (writes.failResults && value?.result) throw new Error("ENOSPC: no space left on device");
      records.set(this.options.name + key, value);
    }
  },
}));
import {
  runCommitProposalOnce,
  cancelCommitProposalOnce,
  acceptsCommitProposalResponse,
  commitProposalOutcome,
  resetCommitProposalExecutionMemoryForTests,
} from "../CommitProposalExecution";
import { reservePromptAnswer } from "../PromptAnswerReservation";
beforeEach(() => {
  records.clear();
  resetCommitProposalExecutionMemoryForTests();
  writes.failResults = false;
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
  // #1682: an outcome is this proposal's own recorded execution, never a look-alike commit.
  it("reports a commit only from the proposal's own execution record", async () => {
    await runCommitProposalOnce("other-session", "p", "selection", async () => ({ success: true, commitHash: "theirs" }));
    expect(await commitProposalOutcome("s", "p")).toEqual({ kind: "not-committed" });

    await runCommitProposalOnce("s", "failed", "selection", async () => ({ success: false, error: "timed out waiting for lock" }));
    expect(await commitProposalOutcome("s", "failed")).toEqual({ kind: "not-committed" });
    await cancelCommitProposalOnce("s", "cancelled");
    expect(await commitProposalOutcome("s", "cancelled")).toEqual({ kind: "not-committed" });
  });

  it("waits for an earlier, abandoned execution of the same proposal and reports its commit", async () => {
    let finish!: () => void;
    const abandoned = runCommitProposalOnce("s", "p", "selection", async () => {
      await new Promise<void>((r) => { finish = r; });
      return { success: true, commitHash: "abc1234", commitDate: "2026-10-16" };
    });
    const outcome = commitProposalOutcome("s", "p");
    finish();
    expect(await outcome).toEqual({ kind: "committed", commitHash: "abc1234", commitDate: "2026-10-16" });
    await abandoned;
    expect(await commitProposalOutcome("s", "p")).toMatchObject({ kind: "committed", commitHash: "abc1234" });
  });

  // Re-review: git succeeded but recording the result threw, which left the tool call unsettled.
  it("still returns and reports a commit git made when recording its result fails", async () => {
    writes.failResults = true;
    const result = await runCommitProposalOnce("s", "p", "selection", async () => ({ success: true, commitHash: "abc1234" }));
    expect(result).toMatchObject({ success: true, commitHash: "abc1234" });
    expect(await commitProposalOutcome("s", "p")).toMatchObject({ kind: "committed", commitHash: "abc1234" });
  });

  // Final review: the response gate and dedup read only the durable record, so after a failed
  // write the card's normal answer was rejected and the MCP waiter never settled.
  it("accepts the normal response and dedups retries when the result write failed", async () => {
    writes.failResults = true;
    const execute = vi.fn(async () => ({ success: true, commitHash: "abc1234" }));
    await runCommitProposalOnce("s", "p", "selection", execute);
    expect(acceptsCommitProposalResponse("s", "p", { action: "committed", commitHash: "abc1234" })).toBe(true);
    expect(acceptsCommitProposalResponse("s", "p", { action: "cancelled" })).toBe(false);
    expect(await runCommitProposalOnce("s", "p", "selection", execute)).toMatchObject({ success: true, commitHash: "abc1234" });
    expect(execute).toHaveBeenCalledOnce();
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
