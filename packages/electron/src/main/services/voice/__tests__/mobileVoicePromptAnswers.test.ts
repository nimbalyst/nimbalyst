// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  records: new Map<string, unknown>(),
  load: vi.fn(),
  owner: vi.fn(),
  resolve: vi.fn(),
}));
vi.mock("../../../utils/privateSettingsStore", () => ({
  default: class {
    constructor(private options: { name: string }) {}
    get(key: string) {
      return mocks.records.get(this.options.name + key);
    }
    set(key: string, value: unknown) {
      mocks.records.set(this.options.name + key, value);
    }
  },
}));
vi.mock("../voiceSessionLoader", () => ({ loadVoiceSession: mocks.load }));
vi.mock("@nimbalyst/runtime/storage/repositories/AISessionsRepository", () => ({
  AISessionsRepository: { get: mocks.owner },
}));
vi.mock("../../ai/MobileSessionControlHandler", () => ({
  resolveExactVoicePromptResponse: mocks.resolve,
}));
import { handleMobileVoicePrompt } from "../mobileVoicePromptAnswers";
import type { MobileLiveScope } from "../mobileLiveRelay";
const scope: MobileLiveScope = {
  version: 1,
  hostDeviceId: "host",
  projectId: "/p",
  sessionId: "s",
  voiceGeneration: "g",
  actionId: "a",
  announcingDeviceId: "phone",
};
const prompt = {
  promptType: "git_commit_proposal",
  status: "pending",
  requestId: "p",
  commitMessage: "Fix voice",
  stagedFiles: ["voice.swift"],
};
function loaded(p = prompt) {
  return {
    sessionId: "s",
    session: {
      title: "A",
      messages: [
        { type: "user_message", id: "task" },
        { type: "interactive_prompt", interactivePrompt: p },
      ],
    },
  };
}
const call = (tool: string, args: object = {}, source = scope) =>
  handleMobileVoicePrompt({
    scope: source,
    tool,
    arguments: JSON.stringify(args),
  });
beforeEach(() => {
  mocks.records.clear();
  vi.clearAllMocks();
  mocks.load.mockResolvedValue(loaded());
  mocks.owner.mockResolvedValue({
    workspacePath: "/p",
    metadata: { hostDeviceId: "host" },
  });
  mocks.resolve.mockResolvedValue({
    success: true,
    result: JSON.stringify({ status: "committed", commitHash: "abc" }),
  });
});
describe("host canonical prompt relay", () => {
  it("rejects changed content, answered prompts, foreign hosts and generations without dispatch", async () => {
    const prepared = await call("voice_prompt_prepare");
    expect(prepared.success).toBe(true);
    const args = { ...JSON.parse(prepared.result!), answer: "approve" };
    expect((await call("voice_prompt_answer", args)).success).toBe(false);
    expect((await call("voice_prompt_presented", args)).success).toBe(true);
    expect(
      (
        await call("voice_prompt_answer", args, {
          ...scope,
          voiceGeneration: "old",
        })
      ).success
    ).toBe(false);
    mocks.load.mockResolvedValue(
      loaded({ ...prompt, stagedFiles: ["secret.txt"] })
    );
    expect((await call("voice_prompt_answer", args)).success).toBe(false);
    mocks.load.mockResolvedValue(loaded({ ...prompt, status: "resolved" }));
    expect((await call("voice_prompt_answer", args)).success).toBe(false);
    mocks.load.mockResolvedValue(loaded());
    mocks.owner.mockResolvedValue({
      workspacePath: "/p",
      metadata: { hostDeviceId: "other" },
    });
    expect((await call("voice_prompt_answer", args)).success).toBe(false);
    expect(mocks.resolve).not.toHaveBeenCalled();
  });
  it("dispatches the exact canonical proposal once and reconciles its actual outcome after reply loss", async () => {
    const prepared = await call("voice_prompt_prepare");
    const args = {
      ...JSON.parse(prepared.result!),
      answer: "approve",
      files: ["forged"],
      message: "forged",
    };
    await call("voice_prompt_presented", args);
    const result = await call("voice_prompt_answer", args);
    expect(JSON.parse(result.result!)).toMatchObject({
      status: "committed",
      commitHash: "abc",
    });
    expect(mocks.resolve).toHaveBeenCalledWith("s", {
      promptType: "git_commit",
      promptId: "p",
      response: {
        action: "committed",
        files: ["voice.swift"],
        message: "Fix voice",
      },
    });
    mocks.load.mockResolvedValue(loaded({ ...prompt, status: "resolved" }));
    expect(await call("voice_prompt_status", args)).toEqual(result);
    await call("voice_prompt_answer", args);
    expect(mocks.resolve).toHaveBeenCalledOnce();
  });
});
