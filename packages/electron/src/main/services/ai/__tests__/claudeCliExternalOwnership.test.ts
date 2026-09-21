// @vitest-environment node
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ownership = vi.hoisted(() => ({
  claim: vi.fn(),
  raw: vi.fn(),
  submit: vi.fn(),
}));
vi.mock("../../externalSessions/ExternalSessionService", () => ({
  claimExternalSessionForLocalExecution: ownership.claim,
}));
vi.mock("../claudeCliSubmit", () => ({
  submitClaudeCliPrompt: ownership.submit,
}));
vi.mock("../claudeCliUserPromptLog", () => ({
  logClaudeCliUserPrompt: ownership.raw,
  broadcastMessageLogged: vi.fn(),
}));
vi.mock("../../analytics/AnalyticsService", () => ({
  AnalyticsService: { getInstance: () => ({ sendEvent: vi.fn() }) },
}));
vi.mock("../aiServiceUtils", () => ({ bucketMessageLength: vi.fn() }));
vi.mock("../claudeCliRevealTerminal", () => ({
  broadcastClaudeCliRevealTerminal: vi.fn(),
}));
vi.mock("../../ClaudeSettingsManager", () => ({ ClaudeSettingsManager: {} }));
vi.mock("@nimbalyst/runtime", () => ({ AgentMessagesRepository: {} }));

// Test singleton coordination without initializing the host's file, auth,
// extension, or auto-naming services through their runtime barrel imports.
vi.mock("../HooklessAgentFileWatcher", () => ({
  HooklessAgentFileWatcher: class {
    ensureForSession = vi.fn(async () => undefined);
    stopForSession = vi.fn(async () => undefined);
    scheduleStop = vi.fn();
  },
}));
vi.mock("../claudeCliSessionAutoNameSingleton", () => ({
  maybeAutoNameClaudeCliSessionProduction: vi.fn(async () => undefined),
}));
vi.mock("../../AgentWorkflowService", () => ({
  getAgentWorkflowService: () => ({
    getClaudeProviderPluginPaths: async () => [],
  }),
}));
vi.mock("../../PermissionService", () => ({
  getPermissionService: () => ({ getPermissionMode: () => "default" }),
}));
vi.mock("../../../utils/store", () => ({
  getDefaultEffortLevel: () => undefined,
}));
vi.mock("../../attachments/attachmentStagingRoot", () => ({
  resolveAttachmentStagingAllowDirectories: () => [],
}));

describe("CLI production external ownership", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  async function loadHarness(opts?: {
    claudeInstalled?: boolean;
    /** When set, the mocked session resolves to this worktree (id + on-disk path). */
    worktree?: { id: string; path: string } | null;
  }) {
    const claudeInstalled = opts?.claudeInstalled ?? true;
    const worktree = opts?.worktree ?? null;
    const manager = {
      isTerminalActive: vi.fn(() => false),
      writeToTerminal: vi.fn(),
    };
    const stateManager = {
      startSession: vi.fn(async () => undefined),
      endSession: vi.fn(async () => undefined),
      updateActivity: vi.fn(async () => undefined),
    };
    const launch = vi.fn(async (_input?: any): Promise<void> => undefined);

    vi.doMock("../../TerminalSessionManager", () => ({
      getTerminalSessionManager: () => manager,
    }));
    vi.doMock("@nimbalyst/runtime/ai/server/SessionStateManager", () => ({
      getSessionStateManager: () => stateManager,
    }));
    vi.doMock("@nimbalyst/runtime/ai/server", () => ({
      McpConfigService: class {
        getMcpServersConfig = vi.fn(async () => ({}));
      },
      getMcpConfigService: () => ({
        getMcpServersConfig: vi.fn(async () => ({})),
      }),
      configureMcpServers: vi.fn(),
    }));
    vi.doMock("../../shellEnvironment", () => ({
      getEnhancedPath: () => "/bin",
      getShellEnvironment: () => ({}),
    }));
    vi.doMock("../claudeExecutableResolver", () => ({
      resolveClaudeExecutablePath: () => "/usr/local/bin/claude",
      isClaudeExecutableInstalled: () => claudeInstalled,
    }));
    vi.doMock("../claudeCliPermissionHookPath", () => ({
      resolveClaudePermissionHookScriptPath: () => undefined,
    }));
    vi.doMock("../claudeCliObservationSingleton", () => ({
      startClaudeCliProxyObservation: vi.fn(),
      fireClaudeCliTurnCompletion: vi.fn(),
    }));
    vi.doMock("../claudeCliQueueFlushSingleton", () => ({
      flushNextClaudeCliQueuedPromptForSession: vi.fn(async () => false),
    }));
    vi.doMock("../ClaudeCliSessionLauncher", () => ({
      ClaudeCliSessionLauncher: class {
        constructor() {
          (this as any).launch = launch;
        }
      },
    }));

    // Worktree resolution deps (#933 / NIM-2001). The session resolves to a
    // worktreeId iff `worktree` is set; the store maps it to the on-disk path.
    vi.doMock(
      "@nimbalyst/runtime/storage/repositories/AISessionsRepository",
      () => ({
        AISessionsRepository: {
          get: vi.fn(async () => ({ worktreeId: worktree?.id ?? null })),
        },
      })
    );
    vi.doMock("../../WorktreeStore", () => ({
      createWorktreeStore: () => ({
        get: vi.fn(async (id: string) =>
          worktree && worktree.id === id ? { path: worktree.path } : null
        ),
      }),
    }));
    vi.doMock("../../../database/initialize", () => ({
      getDatabase: () => ({}),
    }));

    const mod = await import("../claudeCliLauncherSingleton");
    return { ...mod, manager, stateManager, launch };
  }

  it("rejects launch before state/provider side effects on claim failure and succeeds on retry", async () => {
    const h = await loadHarness();
    ownership.claim
      .mockRejectedValueOnce(new Error("claim write failed"))
      .mockResolvedValue(undefined);
    const input = { sessionId: "imported", workspacePath: "/workspace" };
    await expect(h.ensureClaudeCliSession(input)).rejects.toThrow(
      "claim write failed"
    );
    expect(h.stateManager.startSession).not.toHaveBeenCalled();
    expect(h.launch).not.toHaveBeenCalled();
    expect(await h.ensureClaudeCliSession(input)).toEqual({ success: true });
    expect(h.launch).toHaveBeenCalledOnce();
  });
  it("rejects submit before terminal/raw side effects on claim failure and succeeds on retry", async () => {
    const h = await loadHarness();
    const { submitClaudeCliPromptProduction } = await import(
      "../claudeCliSubmitSingleton"
    );
    ownership.claim
      .mockRejectedValueOnce(new Error("claim read failed"))
      .mockResolvedValue(undefined);
    ownership.submit.mockImplementation(async (input, deps) => {
      deps.writeToTerminal(input.sessionId, input.prompt);
      await deps.logUserPrompt(input);
      return { submitted: true };
    });
    const input = {
      sessionId: "imported",
      workspacePath: "/workspace",
      prompt: "Hello",
    };
    await expect(submitClaudeCliPromptProduction(input)).rejects.toThrow(
      "claim read failed"
    );
    expect(h.manager.writeToTerminal).not.toHaveBeenCalled();
    expect(ownership.raw).not.toHaveBeenCalled();
    expect(await submitClaudeCliPromptProduction(input)).toEqual({
      submitted: true,
    });
    expect(h.manager.writeToTerminal).toHaveBeenCalledOnce();
    expect(ownership.raw).toHaveBeenCalledOnce();
  });
});
