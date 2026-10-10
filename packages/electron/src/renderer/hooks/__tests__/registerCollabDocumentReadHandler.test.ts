// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
const readers = vi.hoisted(() => ({
  protected: vi.fn(async () => ({
    content: "outcome only",
    decisionState: { readOnly: true, blocks: [] },
  })),
  raw: vi.fn(async () => ({ content: "PRIVATE_SENTINEL", route: "mounted" })),
  assertProject: vi.fn(),
}));
vi.mock("../../services/readCollabDecisionState", () => ({
  readCollabDocWithDecisionState: readers.protected,
}));
vi.mock("../../services/agentDocumentAccess", () => ({
  readCollabDocForAgent: readers.raw,
  assertCurrentProjectPage: readers.assertProject,
  OtherProjectPageError: class extends Error {
    readonly code = "OTHER_PROJECT";
    constructor(readonly projectId: string | null, message: string) { super(message); }
  },
}));
vi.mock("../../services/HeadlessCollabDocument", () => ({
  HeadlessCollabDocumentError: class extends Error {},
}));
import { registerCollabDocumentReadHandler } from "../registerCollabDocumentReadHandler";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
it("applies the authorized privacy reader to ordinary and supplemental MCP reads", async () => {
  let read!: (request: any) => Promise<void>;
  const send = vi.fn();
  vi.stubGlobal("window", {
    electronAPI: {
      onMcpReadCollabDoc: (callback: typeof read) => {
        read = callback;
        return () => {};
      },
      sendMcpReadCollabDocResult: send,
    },
  });
  registerCollabDocumentReadHandler(() => "/workspace");
  await read({
    targetFilePath: "collab://org:o:doc:d",
    resultChannel: "plain",
  });
  expect(readers.protected).toHaveBeenCalledWith(
    "collab://org:o:doc:d",
    "/workspace"
  );
  expect(readers.raw).not.toHaveBeenCalled();
  expect(send).toHaveBeenLastCalledWith("plain", {
    success: true,
    content: "outcome only",
  });
  await read({
    targetFilePath: "collab://org:o:doc:d",
    resultChannel: "snapshot",
    includeDecisionState: true,
  });
  expect(send).toHaveBeenLastCalledWith("snapshot", {
    success: true,
    content: "outcome only",
    decisionState: { readOnly: true, blocks: [] },
  });
});

it("answers a read of another project's page with that project, before reading it", async () => {
  const { OtherProjectPageError } = await import("../../services/agentDocumentAccess");
  readers.assertProject.mockImplementationOnce(() => {
    throw new OtherProjectPageError("project-b", "a page in another project");
  });
  let read!: (request: any) => Promise<void>;
  const send = vi.fn();
  vi.stubGlobal("window", {
    electronAPI: {
      onMcpReadCollabDoc: (callback: typeof read) => {
        read = callback;
        return () => {};
      },
      sendMcpReadCollabDocResult: send,
    },
  });
  registerCollabDocumentReadHandler(() => "/workspace");
  await read({ targetFilePath: "collab://org:o:doc:theirs", resultChannel: "other" });
  expect(readers.assertProject).toHaveBeenCalledWith("collab://org:o:doc:theirs", "/workspace");
  expect(readers.protected).not.toHaveBeenCalled();
  expect(send).toHaveBeenLastCalledWith("other", {
    success: false,
    code: "OTHER_PROJECT",
    projectId: "project-b",
    error: "a page in another project",
  });
});
