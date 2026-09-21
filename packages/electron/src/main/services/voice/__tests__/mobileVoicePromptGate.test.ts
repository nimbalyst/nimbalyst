// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  VoicePromptGate,
  type VoicePromptLease,
} from "../mobileVoicePromptGate";
import {
  exactVoiceResponse,
  voicePromptReadout,
  voicePromptVersion,
} from "../mobileVoicePromptContract";
import type { GitCommitProposalPayload } from "@nimbalyst/runtime/ai/server/transcript/types";

const prompt: GitCommitProposalPayload = {
  promptType: "git_commit_proposal",
  status: "pending",
  requestId: "p",
  commitMessage: "Fix voice",
  stagedFiles: ["voice.swift"],
};
describe("exact mobile voice prompt answers", () => {
  it("uses canonical files/message and rejects partial, negated, or changed proposals", () => {
    expect(exactVoiceResponse(prompt, "approve")).toMatchObject({
      promptId: "p",
      response: { files: ["voice.swift"], message: "Fix voice" },
    });
    expect(exactVoiceResponse(prompt, "don't approve")).toMatchObject({
      response: { action: "cancelled" },
    });
    for (const text of [
      "yes but not yet",
      "approve if tests pass",
      "the summary says approve",
    ])
      expect(() => exactVoiceResponse(prompt, text)).toThrow();
    expect(voicePromptVersion(prompt, "task")).not.toBe(
      voicePromptVersion({ ...prompt, stagedFiles: ["other.swift"] }, "task")
    );
    expect(() =>
      voicePromptReadout(
        { ...prompt, commitMessage: "x".repeat(2500) },
        "Session"
      )
    ).toThrow(/too long/);
    expect(() =>
      exactVoiceResponse({ ...prompt, status: "resolved" }, "yes")
    ).toThrow(/no longer/);
  });
  it("requires same generation, source, exact version, playback receipt and unexpired lease", async () => {
    const records = new Map<string, VoicePromptLease>();
    let now = 0;
    const gate = new VoicePromptGate(
      (k) => records.get(k),
      (k, v) => {
        records.set(k, v);
      },
      () => now
    );
    const lease = gate.prepare("p", "scope", "v1");
    const execute = vi.fn(async () => ({ success: true }));
    await expect(
      gate.answer("p", "scope", "v1", lease.token, "a", execute)
    ).rejects.toThrow(/finished playing/);
    for (const [binding, version, token] of [
      ["other-generation", "v1", lease.token],
      ["scope", "v2", lease.token],
      ["scope", "v1", "forged"],
    ])
      expect(() => gate.presented("p", binding, version, token)).toThrow();
    gate.presented("p", "scope", "v1", lease.token);
    now = 120001;
    await expect(
      gate.answer("p", "scope", "v1", lease.token, "a", execute)
    ).rejects.toThrow(/expired/);
    expect(execute).not.toHaveBeenCalled();
  });
  it("reserves before dispatch, preserves unknown outcomes across restart, and exposes receipts", async () => {
    const records = new Map<string, VoicePromptLease>();
    const make = () =>
      new VoicePromptGate(
        (k) => records.get(k),
        (k, v) => {
          records.set(k, v);
        }
      );
    const gate = make();
    const lease = gate.prepare("p", "scope", "v1");
    gate.presented("p", "scope", "v1", lease.token);
    let finish!: () => void;
    const execute = vi.fn(async () => {
      await new Promise<void>((r) => {
        finish = r;
      });
      return { success: true, result: "accepted" };
    });
    const running = gate.answer("p", "scope", "v1", lease.token, "a", execute);
    expect(
      (await make().answer("p", "scope", "v1", lease.token, "b", execute))
        .success
    ).toBe(false);
    finish();
    await running;
    expect(make().status("p", "scope", lease.token)).toEqual({
      success: true,
      result: "accepted",
    });
    expect(
      (await make().answer("p", "scope", "v1", lease.token, "a", execute))
        .success
    ).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
  });
});
