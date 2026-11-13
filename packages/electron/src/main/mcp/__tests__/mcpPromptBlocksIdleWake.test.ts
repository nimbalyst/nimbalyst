// @vitest-environment node
/**
 * The idle-wake guard must see prompts raised through the MCP tools, not only
 * the ones raised through provider events. A background-task drain that wakes a
 * lead parked on `mcp__nimbalyst__AskUserQuestion` tears down the transport
 * holding the call, and the agent gets "Connection closed" instead of an answer
 * (#1557). This drives the real MCP handler against the real pending-prompt
 * persistence, so it fails if the guard is wired to a signal the MCP path never
 * writes.
 */
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: new EventEmitter(),
}));
vi.mock("@nimbalyst/runtime/storage/repositories/AgentMessagesRepository", () => ({
  AgentMessagesRepository: { listTail: async () => [] },
}));
vi.mock("@nimbalyst/runtime/storage/repositories/AISessionsRepository", () => ({
  AISessionsRepository: {
    get: async () => ({ id: "session", provider: "claude-code" }),
    updateMetadata: async () => {},
  },
}));
vi.mock("@nimbalyst/runtime/ai/server/SessionStateManager", () => ({
  getSessionStateManager: () => ({ updateActivity: async () => {} }),
}));
vi.mock("@nimbalyst/runtime/sync/pushOutcome", () => ({
  warnIfUnpublished: () => {},
}));
vi.mock("../../services/SyncManager", () => ({ getSyncProvider: () => null }));
vi.mock("../../services/ai/mobilePushRequest", () => ({
  requestMobilePush: async () => {},
}));
vi.mock("../../tray/TrayManager", () => ({
  TrayManager: {
    getInstance: () => ({ onPromptCreated: () => {}, onPromptResolved: () => {} }),
  },
}));
vi.mock("../../utils/logger", () => ({
  logger: { main: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } },
}));
vi.mock("../../services/ai/codexQuestionTurns", () => ({
  codexQuestionTurns: { current: () => undefined, register: () => () => {} },
}));
vi.mock("../tools/codexToolCallResolver", () => ({
  resolveToolUseIdFromMcpRequest: async () => null,
}));
vi.mock("../tools/interactivePromptTranscript", () => ({
  isClaudeCliSession: async () => false,
  persistInteractivePromptToolResult: async () => {},
}));
vi.mock("../tools/interactivePromptSettleState", () => ({
  applyInteractivePromptSettleTurnState: async () => {},
}));

import { ipcMain } from "electron";
import { handleAskUserQuestion } from "../tools/askUserQuestionHandler";
import {
  isSessionBlockedOnUser,
  onSessionUnblocked,
} from "../../services/ai/idleWakeSignals";

const question = {
  header: "Rounds",
  question: "How far should I keep going?",
  options: [{ label: "Stop here", description: "Bank the rest as a ticket" }],
};

afterEach(() => {
  ipcMain.removeAllListeners();
});

describe("MCP interactive prompts and the idle-wake guard", () => {
  it("reports a session blocked while an MCP AskUserQuestion waits, and unblocked once answered", async () => {
    const unblocked: string[] = [];
    const unsubscribe = onSessionUnblocked((id) => unblocked.push(id));

    const pending = handleAskUserQuestion({ questions: [question] }, "session", {});

    // The guard consults this before letting a drain wake start a turn.
    await vi.waitFor(() => expect(isSessionBlockedOnUser("session")).toBe(true));
    expect(unblocked).toEqual([]);

    ipcMain.emit("ask-user-question:session", {}, {
      answers: { [question.question]: "Stop here" },
    });
    await pending;

    // The held wake is released from this signal.
    await vi.waitFor(() => expect(unblocked).toEqual(["session"]));
    expect(isSessionBlockedOnUser("session")).toBe(false);
    unsubscribe();
  });
});
