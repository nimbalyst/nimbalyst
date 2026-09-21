// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as reader from "../jsonlReader";
import { ClaudeCodeSource } from "../ClaudeCodeSource";
import { encodeWorkspaceDir } from "../../ClaudeCodeSessionScanner";
import { entryToMessage } from "../claudeCodeImportCodec";
vi.mock("node:fs/promises", { spy: true });
let dir: string;
let source: ClaudeCodeSource;
const cwd = "/workspace/a.b";
const timestamp = "2026-09-14T10:00:00.000Z";
const entry = (uuid: string, content: unknown = "hello") => ({
  type: "user",
  sessionId: "parent",
  uuid,
  cwd,
  timestamp,
  message: { role: "user", content },
});
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "external-claude-"));
  source = new ClaudeCodeSource({ rootDir: dir, maxDiscoveryEntries: 20 });
  await fs.mkdir(path.join(dir, encodeWorkspaceDir(cwd)));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(fs.open).mockImplementation(
    (
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises"
      )
    ).open
  );
  await source.dispose();
  await fs.rm(dir, { recursive: true, force: true });
});
const write = async (file: string, entries: unknown[]) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(
    file,
    entries.map((e) => JSON.stringify(e)).join("\n") + "\n"
  );
};
it("discovers log-verified parent and late sidecar files, reuses the manual codec and keeps independent cursors", async () => {
  const file = path.join(dir, encodeWorkspaceDir(cwd), "parent.jsonl");
  await write(file, [entry("u1")]);
  const [ref] = await source.discover(cwd);
  expect(ref).toMatchObject({
    externalId: "parent",
    workspacePath: cwd,
    filePath: file,
  });
  const main = await source.readSince(ref, null);
  expect(main.messages[0]).toMatchObject(entryToMessage(entry("u1") as any)!);
  const sidecar = path.join(
    dir,
    encodeWorkspaceDir(cwd),
    "parent/subagents/agent-agent1.jsonl"
  );
  await write(sidecar, [
    { ...entry("s1"), isSidechain: true, agentId: "agent1" },
  ]);
  const refs = await source.discover(cwd);
  const subref = refs.find((r) => r.parentToolUseId === "agent1")!;
  expect(subref).toMatchObject({ externalId: "parent", filePath: sidecar });
  const sub = await source.readSince(subref, null);
  expect(JSON.parse(sub.messages[0].content).parent_tool_use_id).toBe("agent1");
  expect(sub.messages[0].sourceEntryId).not.toBe(
    main.messages[0].sourceEntryId
  );
  expect((await source.readSince(ref, main.cursor)).messages).toEqual([]);
  await fs.appendFile(file, JSON.stringify(entry("u2", "again")) + "\n");
  expect((await source.readSince(ref, main.cursor)).messages).toHaveLength(1);
});
it("rejects cwd encoding collisions, forged references and symlinks outside the source root", async () => {
  const file = path.join(dir, encodeWorkspaceDir(cwd), "parent.jsonl");
  await write(file, [{ ...entry("u1"), cwd: "/workspace/a-b" }]);
  expect(await source.discover(cwd)).toEqual([]);
  await expect(
    source.readSince(
      {
        providerId: "claude-code",
        externalId: "parent",
        workspacePath: cwd,
        filePath: file,
        updatedAt: 0,
      },
      null
    )
  ).rejects.toThrow();
  await fs.unlink(file);
  const outside = path.join(dir, "outside.jsonl");
  await write(outside, [entry("u1")]);
  await fs.symlink(outside, file);
  expect(await source.discover(cwd)).toEqual([]);
});
it("inlines only bounded tool results inside the session sidecar directory", async () => {
  const file = path.join(dir, encodeWorkspaceDir(cwd), "parent.jsonl");
  const output = path.join(
    dir,
    encodeWorkspaceDir(cwd),
    "parent/tool-results/result.txt"
  );
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, "full result");
  const marker = `<persisted-output>\nFull output saved to: ${output}\npreview\n</persisted-output>`;
  await write(file, [
    entry("u1", [
      { type: "tool_result", tool_use_id: "tool1", content: marker },
    ]),
  ]);
  const [ref] = await source.discover(cwd);
  expect(
    JSON.parse((await source.readSince(ref, null)).messages[0].content).message
      .content[0].content
  ).toBe("full result");
});

it("identifies changed files directly and manually discovers unterminated records with prompt titles across workspaces", async () => {
  const file = path.join(dir, encodeWorkspaceDir(cwd), "parent.jsonl");
  await fs.writeFile(file, JSON.stringify(entry("manual")));
  expect(await source.identify(file, [cwd])).toBeNull();
  const page = await source.discoverPage();
  expect(page.hasMore).toBe(false);
  expect(page.sessions).toMatchObject([
    { workspacePath: cwd, title: "hello..." },
  ]);
  const ref = page.sessions[0];
  const manual = await source.readSince(ref, null, { includeFinalLine: true });
  expect(manual.messages).toHaveLength(1);
  expect(manual.cursor.byteOffset).toBe(0);
  await fs.appendFile(file, "\n");
  expect(await source.identify(file, ["/elsewhere", cwd])).toMatchObject({
    externalId: "parent",
    workspacePath: cwd,
  });
  expect(await source.identify(file, ["/elsewhere"])).toBeNull();
  const sidecar = path.join(
    dir,
    encodeWorkspaceDir(cwd),
    "parent/subagents/agent-late.jsonl"
  );
  await write(sidecar, [{ ...entry("late"), isSidechain: true }]);
  expect(await source.identify(sidecar, [cwd])).toMatchObject({
    parentToolUseId: "late",
    externalId: "parent",
  });
});

it("does not overwrite a later AI title with the header prompt fallback on subsequent appends", async () => {
  await source.dispose();
  source = new ClaudeCodeSource({ rootDir: dir, maxReadBytes: 64 });
  const file = path.join(dir, encodeWorkspaceDir(cwd), "parent.jsonl");
  await write(file, [entry("first")]);
  const ref = (await source.identify(file, [cwd]))!;
  const first = await source.readSince(ref, null);
  expect(first.title).toBe("hello...");
  await fs.appendFile(
    file,
    JSON.stringify({ type: "summary", aiTitle: "Chosen title" }) + "\n"
  );
  const titled = await source.readSince(ref, first.cursor);
  expect(titled.title).toBe("Chosen title");
  await fs.appendFile(file, JSON.stringify(entry("later", "Continue")) + "\n");
  const later = await source.readSince(ref, titled.cursor);
  expect(later.title).toBe("Chosen title");
});

it("inherits missing sidecar cwd only from a verified parent and rejects explicit scope or identity conflicts", async () => {
  const parent = path.join(dir, encodeWorkspaceDir(cwd), "parent.jsonl");
  const sidecar = path.join(
    dir,
    encodeWorkspaceDir(cwd),
    "parent/subagents/agent-child.jsonl"
  );
  const assistant = {
    type: "assistant",
    uuid: "child-message",
    sessionId: "parent",
    agentId: "child",
    timestamp,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Subagent reply" }],
    },
  };
  await write(parent, [entry("parent-prompt")]);
  await write(sidecar, [assistant]);
  const ref = await source.identify(sidecar, [cwd]);
  expect(ref).toMatchObject({
    workspacePath: cwd,
    externalId: "parent",
    parentToolUseId: "child",
  });
  const page = await source.discoverPage();
  expect(page.sessions.find((r) => r.filePath === sidecar)).toMatchObject({
    workspacePath: cwd,
  });
  const imported = await source.readSince(ref!, null);
  expect(imported.messages).toHaveLength(1);
  expect(JSON.parse(imported.messages[0].content)).toMatchObject({
    type: "assistant",
    parent_tool_use_id: "child",
    message: assistant.message,
  });
  for (const conflict of [
    { cwd: "/workspace/a-b" },
    { cwd: null },
    { sessionId: "other" },
    { agentId: "other" },
  ]) {
    await write(sidecar, [
      assistant,
      { ...assistant, uuid: "conflicting", ...conflict },
    ]);
    expect(await source.identify(sidecar, [cwd])).toBeNull();
    await expect(source.readSince(ref!, null)).rejects.toThrow();
  }
  await write(sidecar, [assistant]);
  await fs.unlink(parent);
  expect(await source.identify(sidecar, [cwd])).toBeNull();
  await write(parent, [{ ...entry("parent-without-cwd"), cwd: undefined }]);
  expect(await source.identify(sidecar, [cwd])).toBeNull();
});

it("reuses parent and sidecar headers on append but rejects a replaced parent cwd", async () => {
  const parent = path.join(dir, encodeWorkspaceDir(cwd), "parent.jsonl");
  const sidecar = path.join(
    dir,
    encodeWorkspaceDir(cwd),
    "parent/subagents/agent-agent1.jsonl"
  );
  await write(parent, [entry("u1", "x".repeat(60000))]);
  await write(sidecar, [
    { ...entry("s1"), cwd: undefined, agentId: "agent1", isSidechain: true },
  ]);
  const ref = (await source.identify(sidecar, [cwd]))!;
  const first = await source.readSince(ref, null);
  const spy = vi.spyOn(reader, "readJsonl");
  const realpaths = vi.spyOn(reader, "validateSourcePath");
  let readBytes = 0;
  const originalOpen = (
    await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
  ).open;
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await originalOpen(...args);
    const read = handle.read.bind(handle);
    handle.read = (async (...readArgs: any[]) => {
      const result = await (read as any)(...readArgs);
      readBytes += result.bytesRead;
      return result;
    }) as typeof handle.read;
    return handle;
  });
  await fs.appendFile(
    sidecar,
    JSON.stringify({
      ...entry("s2"),
      cwd: undefined,
      agentId: "agent1",
      isSidechain: true,
    }) + "\n"
  );
  await source.readSince(ref, first.cursor);
  expect(spy.mock.calls.filter((call) => call[1] === null)).toHaveLength(0);
  expect(realpaths).not.toHaveBeenCalled();
  expect(readBytes).toBeLessThan(50 * 1024);
  await write(parent, [
    { ...entry("u1", "x".repeat(60010)), cwd: "/foreign/project" },
  ]);
  await expect(source.readSince(ref, first.cursor)).rejects.toThrow(
    "validation"
  );
});

it("retains explicit Claude renames through cached empty passes and older conversation replay", async () => {
  const file = path.join(dir, encodeWorkspaceDir(cwd), "parent.jsonl");
  await write(file, [
    entry("first"),
    { type: "ai-title", sessionId: "parent", aiTitle: "Automatic name" },
  ]);
  const ref = (await source.identify(file, [cwd]))!;
  const first = await source.readSince(ref, null);
  expect(first.title).toBe("Automatic name");
  expect(first.titleKind).toBe("generated");
  await fs.appendFile(
    file,
    JSON.stringify({
      type: "custom-title",
      sessionId: "parent",
      customTitle: "User chosen name",
    }) + "\n"
  );
  expect((await source.identify(file, [cwd]))?.title).toBe("User chosen name");
  const renamed = await source.readSince(ref, first.cursor);
  expect(renamed.messages).toEqual([]);
  expect(renamed.title).toBe("User chosen name");
  expect(renamed.titleKind).toBe("explicit");
  expect((await source.readSince(ref, renamed.cursor)).title).toBe(
    "User chosen name"
  );
  await fs.appendFile(
    file,
    JSON.stringify({
      type: "ai-title",
      sessionId: "parent",
      aiTitle: "Later automatic name",
    }) + "\n"
  );
  expect((await source.readSince(ref, renamed.cursor)).title).toBe(
    "User chosen name"
  );
  expect((await source.readSince(ref, null)).title).toBe("User chosen name");
  await source.dispose();
  source = new ClaudeCodeSource({ rootDir: dir });
  expect((await source.readSince(ref, null)).title).toBe("User chosen name");
});

it("never offers a sidecar prompt or explicit title as its parent's title", async () => {
  const file = path.join(dir, encodeWorkspaceDir(cwd), "parent.jsonl");
  const sidecar = path.join(
    dir,
    encodeWorkspaceDir(cwd),
    "parent/subagents/agent-child.jsonl"
  );
  await write(file, [entry("first")]);
  await write(sidecar, [
    { ...entry("child"), agentId: "child" },
    {
      type: "custom-title",
      sessionId: "parent",
      agentId: "child",
      customTitle: "Child title",
    },
  ]);
  const ref = (await source.identify(sidecar, [cwd]))!;
  expect(ref.title).toBeUndefined();
  expect(ref.titleKind).toBeUndefined();
  const page = await source.readSince(ref, null);
  expect(page.title).toBeUndefined();
  expect(page.titleKind).toBeUndefined();
  expect(page.messages).toHaveLength(1);
});

it.each(["restart", "title-cache eviction"])(
  "withholds incomplete reconstructed titles after %s until the saved cursor is covered",
  async (mode) => {
    const file = path.join(dir, encodeWorkspaceDir(cwd), "parent.jsonl");
    await write(file, [
      entry("first", "Original prompt"),
      ...Array.from({ length: 8 }, (_, i) => ({
        type: "progress",
        sessionId: "parent",
        padding: "x".repeat(160),
        uuid: `padding-${i}`,
      })),
      {
        type: "custom-title",
        sessionId: "parent",
        customTitle: "Earlier explicit name",
      },
      { type: "progress", sessionId: "parent", padding: "x".repeat(200) },
      {
        type: "custom-title",
        sessionId: "parent",
        customTitle: "Latest explicit name",
      },
    ]);
    const ref = (await source.identify(file, [cwd]))!;
    const initial = await source.readSince(ref, null);
    expect(initial.title).toBe("Latest explicit name");
    const cursor = JSON.parse(JSON.stringify(initial.cursor));
    if (mode === "restart") {
      await source.dispose();
      source = new ClaudeCodeSource({ rootDir: dir, maxReadBytes: 128 });
    } else {
      // Force the independently bounded title cache to lose history while the
      // accepted-header cache still holds an EOF cursor.
      (source as unknown as { titles: Map<string, unknown> }).titles.clear();
    }
    let recovered: string | undefined;
    const spy = vi.spyOn(reader, "readJsonl");
    for (let i = 0; i < 40; i++) {
      const page = await source.readSince(ref, cursor);
      expect(page.messages).toEqual([]);
      expect([undefined, "Latest explicit name"]).toContain(page.title);
      expect(page.titleKind).toBe(page.title ? "explicit" : undefined);
      expect(page.cursor.byteOffset).toBe(cursor.byteOffset);
      if (page.title) {
        recovered = page.title;
        break;
      }
    }
    expect(recovered).toBe("Latest explicit name");
    if (mode === "restart")
      expect(
        spy.mock.calls.every((call) => call[2]?.maxReadBytes === 128)
      ).toBe(true);
  }
);

it("recovers a first-prompt fallback after bounded restart reconstruction when no explicit title exists", async () => {
  const file = path.join(dir, encodeWorkspaceDir(cwd), "parent.jsonl");
  await write(file, [
    entry("first", "Recover fallback"),
    ...Array.from({ length: 5 }, () => ({
      type: "progress",
      sessionId: "parent",
      padding: "x".repeat(160),
    })),
  ]);
  const ref = (await source.identify(file, [cwd]))!;
  const first = await source.readSince(ref, null);
  await source.dispose();
  source = new ClaudeCodeSource({ rootDir: dir, maxReadBytes: 128 });
  let title: string | undefined;
  for (let i = 0; i < 20 && !title; i++)
    title = (await source.readSince(ref, first.cursor)).title;
  expect(title).toBe("Recover fallback...");
});

it("pairs initial first-prompt titles with fallback provenance", async () => {
  const file = path.join(dir, encodeWorkspaceDir(cwd), "parent.jsonl");
  await write(file, [entry("initial", "Initial request")]);
  const ref = (await source.identify(file, [cwd]))!;
  expect(ref).toMatchObject({
    title: "Initial request...",
    titleKind: "fallback",
  });
  expect(await source.readSince(ref, null)).toMatchObject({
    title: "Initial request...",
    titleKind: "fallback",
  });
});
