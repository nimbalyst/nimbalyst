// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  handlers: new Map<string, Function>(),
  scan: vi.fn(),
  sync: vi.fn(),
}));
vi.mock("../../utils/ipcRegistry", () => ({
  safeHandle: (key: string, handler: Function) => h.handlers.set(key, handler),
  removeHandler: (key: string) => h.handlers.delete(key),
}));
vi.mock("../../services/externalSessions/ExternalSessionService", () => ({
  getExternalSessionService: () => ({ scan: h.scan, sync: h.sync }),
}));
vi.mock("../../services/analytics/AnalyticsService", () => ({
  AnalyticsService: { getInstance: () => ({ sendEvent: vi.fn() }) },
}));
import {
  initializeClaudeCodeSessionHandlers,
  cleanupClaudeCodeSessionHandlers,
} from "../ClaudeCodeSessionHandlers";
const selection = {
  providerId: "openai-codex",
  sessionId: "external",
  workspacePath: "/workspace",
};
beforeEach(() => {
  vi.clearAllMocks();
  h.handlers.clear();
  initializeClaudeCodeSessionHandlers();
});
describe("External session IPC", () => {
  it("routes generic scan and manual sync to the shared service without an opt-in requirement", async () => {
    h.scan.mockResolvedValue([selection]);
    h.sync.mockResolvedValue([
      { ...selection, success: true, messagesAdded: 2 },
    ]);
    expect(h.handlers.has("external-sessions:scan")).toBe(true);
    expect(
      await h.handlers.get("external-sessions:scan")!(
        {},
        { providerId: "openai-codex" }
      )
    ).toEqual({ success: true, sessions: [selection] });
    expect(
      await h.handlers.get("external-sessions:sync")!(
        {},
        { sessions: [selection] }
      )
    ).toMatchObject({ success: true, successCount: 1, failureCount: 0 });
    expect(h.sync).toHaveBeenCalledWith([selection], undefined);
  });
  it("rejects unsupported providers and renderer supplied file paths before service access", async () => {
    const handler = h.handlers.get("external-sessions:sync");
    expect(handler).toBeTypeOf("function");
    expect(
      await handler!(
        {},
        { sessions: [{ ...selection, providerId: "copilot" }] }
      )
    ).toMatchObject({ success: false });
    expect(
      await handler!(
        {},
        { sessions: [{ ...selection, filePath: "/untrusted" }] }
      )
    ).toMatchObject({ success: false });
    expect(h.sync).not.toHaveBeenCalled();
  });
  it("retains legacy Claude handlers and shares ingestion, then unregisters both channel families", async () => {
    const claude = { ...selection, providerId: "claude-code" };
    h.scan.mockResolvedValue([claude]);
    h.sync.mockResolvedValue([{ ...claude, success: true, messagesAdded: 1 }]);
    await h.handlers.get("claude-code:sync-sessions")!(
      {},
      { sessionIds: ["external"], workspacePath: "/workspace" }
    );
    expect(h.sync).toHaveBeenCalledWith([claude], "/workspace");
    cleanupClaudeCodeSessionHandlers();
    expect(h.handlers.size).toBe(0);
  });
});
