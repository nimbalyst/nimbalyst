// @vitest-environment jsdom
import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentReviewPanel } from "../AgentReviewPanel";

const testState = vi.hoisted(() => ({
  visibleItemCount: 1,
  fileEdits: [] as Array<{
    filePath: string;
    operation: "edit";
    sessionId: string;
    timestamp: string;
  }>,
  workstreamFileEdits: [] as Array<{
    filePath: string;
    operation: "edit";
    sessionId: string;
    timestamp: string;
  }>,
  uncommittedFiles: [] as string[],
  changedWorktreeFiles: [] as Array<{
    path: string;
    status: "modified";
    staged: boolean;
  }>,
  workstreamSessions: ["active-session", "other-session"],
}));

vi.mock("jotai", () => ({
  useAtomValue: (atom: string) => {
    if (atom.startsWith("session-file-edits:")) {
      return atom === "session-file-edits:workstream"
        ? testState.workstreamFileEdits
        : testState.fileEdits;
    }
    switch (atom) {
      case "workstream-file-edits":
        return [...testState.fileEdits, ...testState.workstreamFileEdits];
      case "workspace-uncommitted-files":
        return testState.uncommittedFiles;
      case "worktree-changed-files":
        return testState.changedWorktreeFiles;
      case "workstream-sessions":
        return testState.workstreamSessions;
      default:
        throw new Error(`Unexpected atom: ${String(atom)}`);
    }
  },
}));

vi.mock("@nimbalyst/runtime", () => ({
  MaterialSymbol: ({ icon }: { icon: string }) => <span data-icon={icon} />,
}));

vi.mock("virtua", () => ({
  VList: ({
    data,
    children,
  }: {
    data: Array<{ filePath: string; status: string }>;
    children: (
      item: { filePath: string; status: string },
      index: number
    ) => React.ReactNode;
  }) => (
    <div data-testid="virtual-review-list">
      {data
        .slice(0, testState.visibleItemCount)
        .map((item, index) => children(item, index))}
    </div>
  ),
}));

vi.mock("../../../store/atoms/sessionFiles", () => ({
  sessionFileEditsAtom: (sessionId: string) =>
    `session-file-edits:${sessionId}`,
  workstreamFileEditsAtom: () => "workstream-file-edits",
  workspaceUncommittedFilesAtom: () => "workspace-uncommitted-files",
  worktreeChangedFilesAtom: () => "worktree-changed-files",
}));

vi.mock("../../../store/atoms/sessions", () => ({
  workstreamSessionsAtom: () => "workstream-sessions",
}));

vi.mock("../../../store/listeners/fileStateListeners", () => ({
  loadInitialSessionFileState: vi.fn(),
  registerSessionWorkspace: vi.fn(),
  registerWorktreePath: vi.fn(),
}));

vi.mock("../../PullRequestMode/PrFileDiff", () => ({
  InlineFileDiff: ({
    filePath,
    unifiedDiff,
  }: {
    filePath: string;
    unifiedDiff: string;
  }) => <div>{`diff:${filePath}:${unifiedDiff}`}</div>,
}));

const defaultProps = {
  workstreamId: "workstream",
  activeSessionId: "active-session",
  workspacePath: "/workspace",
  width: 360,
};

function diffFor(filePath: string) {
  return {
    unifiedDiff: `@@ -1 +1 @@\n-old\n+${filePath}`,
    isBinary: false,
  };
}

beforeEach(() => {
  testState.visibleItemCount = 1;
  testState.fileEdits = [
    {
      filePath: "/workspace/src/a.ts",
      operation: "edit",
      sessionId: "active-session",
      timestamp: "2026-07-24T10:00:00.000Z",
    },
    {
      filePath: "/workspace/src/b.ts",
      operation: "edit",
      sessionId: "active-session",
      timestamp: "2026-07-24T10:00:01.000Z",
    },
    {
      filePath: "/workspace/src/c.ts",
      operation: "edit",
      sessionId: "active-session",
      timestamp: "2026-07-24T10:00:02.000Z",
    },
  ];
  testState.workstreamFileEdits = [
    {
      filePath: "/workspace/src/other-session.ts",
      operation: "edit",
      sessionId: "workstream",
      timestamp: "2026-07-24T09:00:00.000Z",
    },
  ];
  testState.uncommittedFiles = [];
  testState.changedWorktreeFiles = [];
  testState.workstreamSessions = ["active-session", "other-session"];
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    invoke: vi.fn(
      async (channel: string, _workspacePath: string, ...args: unknown[]) => {
        if (channel !== "session:file-diff") {
          throw new Error(`Unexpected channel: ${channel}`);
        }
        return diffFor(args[1] as string);
      }
    ),
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AgentReviewPanel diff loading", () => {
  it("loads only rendered virtual rows and reuses cached diffs", async () => {
    testState.uncommittedFiles = ["/workspace/src/unrelated.ts"];
    const { rerender } = render(<AgentReviewPanel {...defaultProps} />);

    await screen.findByText(/diff:src\/a\.ts:/);
    expect(screen.getByText("4 files")).toBeTruthy();
    expect(window.electronAPI.invoke).toHaveBeenCalledTimes(1);
    expect(window.electronAPI.invoke).toHaveBeenCalledWith(
      "session:file-diff",
      "/workspace",
      "active-session",
      "/workspace/src/a.ts"
    );

    expect(screen.queryByTitle("src/b.ts")).toBeNull();
    expect(screen.queryByTitle("src/unrelated.ts")).toBeNull();
    expect(window.electronAPI.invoke).not.toHaveBeenCalledWith(
      "session:file-diff",
      "/workspace",
      "active-session",
      "/workspace/src/c.ts"
    );

    testState.visibleItemCount = 2;
    rerender(<AgentReviewPanel {...defaultProps} width={361} />);

    await screen.findByText(/diff:src\/b\.ts:/);
    expect(window.electronAPI.invoke).toHaveBeenCalledTimes(2);

    testState.visibleItemCount = 1;
    rerender(<AgentReviewPanel {...defaultProps} width={362} />);
    testState.visibleItemCount = 2;
    rerender(<AgentReviewPanel {...defaultProps} width={363} />);
    await screen.findByText(/diff:src\/b\.ts:/);

    const firstHeader = screen.getByTitle("src/a.ts").closest("button");
    expect(firstHeader).not.toBeNull();
    fireEvent.click(firstHeader!);
    fireEvent.click(firstHeader!);

    await waitFor(() => {
      expect(window.electronAPI.invoke).toHaveBeenCalledTimes(2);
    });
  });

  it("defaults to the workstream and can target the current session", async () => {
    testState.visibleItemCount = 5;
    render(<AgentReviewPanel {...defaultProps} />);

    expect(screen.getByText("Workstream Review")).toBeTruthy();
    expect(screen.getByText("All sessions (2)")).toBeTruthy();
    expect(screen.getByText("4 files")).toBeTruthy();

    fireEvent.click(screen.getByTestId("workstream-review-target"));
    fireEvent.click(screen.getByLabelText("Current session only"));

    await waitFor(() => {
      expect(screen.getByText("3 files")).toBeTruthy();
    });
    expect(screen.getByText("Current session only")).toBeTruthy();
  });

  it("waits for an expanded row before loading a new diff scope", async () => {
    const { rerender } = render(<AgentReviewPanel {...defaultProps} />);
    await screen.findByText(/diff:src\/a\.ts:/);

    const firstHeader = screen.getByTitle("src/a.ts").closest("button");
    expect(firstHeader).not.toBeNull();
    fireEvent.click(firstHeader!);

    rerender(
      <AgentReviewPanel
        {...defaultProps}
        activeSessionId="replacement-session"
      />
    );
    await waitFor(() => {
      expect(window.electronAPI.invoke).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(firstHeader!);
    await waitFor(() => {
      expect(window.electronAPI.invoke).toHaveBeenCalledTimes(2);
    });
    expect(window.electronAPI.invoke).toHaveBeenLastCalledWith(
      "session:file-diff",
      "/workspace",
      "replacement-session",
      "/workspace/src/a.ts"
    );

    fireEvent.click(firstHeader!);
    fireEvent.click(firstHeader!);
    await waitFor(() => {
      expect(window.electronAPI.invoke).toHaveBeenCalledTimes(2);
    });
  });

  it("invalidates cached diffs when edit or git source data refreshes", async () => {
    testState.visibleItemCount = 2;
    const { rerender } = render(<AgentReviewPanel {...defaultProps} />);

    await waitFor(() => {
      expect(window.electronAPI.invoke).toHaveBeenCalledTimes(2);
    });

    testState.fileEdits = testState.fileEdits.map((edit) =>
      edit.filePath === "/workspace/src/a.ts"
        ? { ...edit, timestamp: "2026-07-24T10:01:00.000Z" }
        : edit
    );
    rerender(<AgentReviewPanel {...defaultProps} width={361} />);

    await waitFor(() => {
      expect(window.electronAPI.invoke).toHaveBeenCalledTimes(3);
    });
    expect(window.electronAPI.invoke).toHaveBeenLastCalledWith(
      "session:file-diff",
      "/workspace",
      "active-session",
      "/workspace/src/a.ts"
    );

    testState.uncommittedFiles = [...testState.uncommittedFiles];
    rerender(<AgentReviewPanel {...defaultProps} width={362} />);

    await waitFor(() => {
      expect(window.electronAPI.invoke).toHaveBeenCalledTimes(5);
    });
  });

  it("normalizes session-history patches before rendering", async () => {
    testState.fileEdits = [testState.fileEdits[0]];
    const invoke = vi.fn(async () => ({
      unifiedDiff: [
        "Index: /workspace/src/a.ts",
        "===================================================================",
        "--- /workspace/src/a.ts\t",
        "+++ /workspace/src/a.ts\t",
        "@@ -1,1 +1,1 @@",
        "-old",
        "+new",
        "",
      ].join("\n"),
      isBinary: false,
    }));
    (window as unknown as { electronAPI: unknown }).electronAPI = { invoke };

    render(<AgentReviewPanel {...defaultProps} />);

    await screen.findByText((content) =>
      content.startsWith("diff:src/a.ts:--- /workspace/src/a.ts")
    );
    expect(screen.queryByText(/Index: \/workspace\/src\/a\.ts/)).toBeNull();
  });

  it("tries workstream session baselines before falling back to the git diff", async () => {
    testState.fileEdits = [
      {
        filePath: "/workspace/src/a.ts",
        operation: "edit",
        sessionId: "active-session",
        timestamp: "2026-07-24T10:00:00.000Z",
      },
    ];
    const invoke = vi.fn(
      async (channel: string, _workspacePath: string, ...args: unknown[]) => {
        if (channel === "session:file-diff") {
          return {};
        }
        if (channel === "git:file-diff") {
          return { unifiedDiff: "", isBinary: true };
        }
        throw new Error(`Unexpected channel: ${channel}`);
      }
    );
    (window as unknown as { electronAPI: unknown }).electronAPI = { invoke };

    render(<AgentReviewPanel {...defaultProps} />);

    await screen.findByText("Binary file — no text diff available.");
    expect(invoke.mock.calls).toEqual([
      [
        "session:file-diff",
        "/workspace",
        "active-session",
        "/workspace/src/a.ts",
      ],
      [
        "session:file-diff",
        "/workspace",
        "other-session",
        "/workspace/src/a.ts",
      ],
      [
        "git:file-diff",
        "/workspace",
        { path: "/workspace/src/a.ts", group: "working" },
      ],
    ]);
  });
});
