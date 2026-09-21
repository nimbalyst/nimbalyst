// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CodexSource } from "../CodexSource";
import * as reader from "../jsonlReader";
import { CodexRawParserDispatcher } from "@nimbalyst/runtime/ai/server/transcript/parsers/CodexRawParserDispatcher";
import type { ParseContext } from "@nimbalyst/runtime/ai/server/transcript/parsers/IRawMessageParser";
vi.mock("node:fs/promises", { spy: true });
let dir: string;
let source: CodexSource;
const cwd = "/workspace/project";
const timestamp = "2026-09-14T10:00:00.000Z";
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "external-codex-"));
  source = new CodexSource({
    ...{ now: () => new Date(timestamp) },
    rootDir: dir,
    maxReadBytes: 600,
    now: () => new Date(timestamp),
  });
  await fs.mkdir(path.join(dir, "2026/09/14"), { recursive: true });
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
it("maps a structural rollout fixture through the dispatcher to golden canonical events across batches/restart", async () => {
  const file = path.join(dir, "2026/09/14/rollout-test.jsonl");
  await fs.copyFile(path.join(__dirname, "fixtures/codex-rollout.jsonl"), file);
  const [ref] = await source.discover(cwd);
  expect(ref).toMatchObject({ externalId: "thread-test", workspacePath: cwd });
  let cursor = null;
  const messages = [];
  let model;
  for (let i = 0; i < 30; i++) {
    const page = await source.readSince(ref, cursor);
    messages.push(...page.messages);
    cursor = page.cursor;
    model = page.model ?? model;
    if (!page.hasMore) break;
  }
  expect(model).toBe("gpt-test");
  expect(messages).toHaveLength(5);
  const events = [];
  const context: ParseContext = {
    sessionId: "local",
    hasToolCall: () => false,
    hasSubagent: () => false,
    findByProviderToolCallId: async () => null,
    findActiveToolCallByRawProviderId: async () => null,
  };
  for (const [index, message] of messages.entries()) {
    // New dispatcher per row exercises the same state loss as incremental migration.
    events.push(
      ...(await new CodexRawParserDispatcher().parseMessage(
        {
          id: index + 1,
          sessionId: "local",
          source: "openai-codex",
          ...message,
          metadata: message.metadata ?? undefined,
          createdAt: new Date(message.timestamp),
        },
        context
      ))
    );
  }
  const date = new Date(timestamp);
  const toolId = "nimtc|call-test|0|0";
  expect(events).toEqual([
    {
      type: "user_message",
      text: "Read the file",
      mode: "agent",
      attachments: undefined,
      createdAt: date,
    },
    {
      type: "assistant_message",
      text: "",
      thinking: "Inspect the file",
      createdAt: date,
    },
    {
      type: "tool_call_started",
      toolName: "read_file",
      toolDisplayName: "read_file",
      arguments: { path: "hello.txt" },
      targetFilePath: null,
      mcpServer: null,
      mcpTool: null,
      providerToolCallId: toolId,
      createdAt: date,
    },
    {
      type: "tool_call_completed",
      providerToolCallId: toolId,
      status: "completed",
      result: "hello world",
      isError: false,
    },
    { type: "assistant_message", text: "Done", createdAt: date },
  ]);
  const restarted = new CodexSource({
    ...{ now: () => new Date(timestamp) },
    rootDir: dir,
  });
  expect((await restarted.readSince(ref, cursor)).messages).toEqual([]);
  const replay = await drain(restarted, ref);
  expect(replay.messages.map((m) => m.sourceEntryId)).toEqual(
    messages.map((m) => m.sourceEntryId)
  );
  await restarted.dispose();
});
it("bounds discovery, rejects foreign cwd and returns roots that survive year rollover", async () => {
  await source.dispose();
  source = new CodexSource({
    ...{ now: () => new Date(timestamp) },
    rootDir: dir,
    maxDiscoveryEntries: 1,
    now: () => new Date("2027-01-01T00:00:00Z"),
  });
  const file = path.join(dir, "2026/09/14/rollout-foreign.jsonl");
  await fs.writeFile(
    file,
    JSON.stringify({
      type: "session_meta",
      payload: { id: "foreign", cwd: "/other" },
    }) + "\n"
  );
  for (let i = 0; i < 8; i++) expect(await source.discover(cwd)).toEqual([]);
  await expect(
    source.readSince(
      {
        providerId: "openai-codex",
        externalId: "foreign",
        workspacePath: cwd,
        filePath: file,
        updatedAt: 0,
      },
      null
    )
  ).rejects.toThrow();
  expect(source.watchRoots([cwd])).toEqual(
    expect.arrayContaining([
      dir,
      path.join(dir, "2027"),
      path.join(dir, "2027/01"),
      path.join(dir, "2027/01/01"),
      path.join(dir, "2026/12/31"),
    ])
  );
  expect(source.watchRoots([])).toEqual([]);
});
it("uses native response identities when timestamps change on replay and maps custom tool calls", async () => {
  const file = path.join(dir, "2026/09/14/rollout-tools.jsonl");
  const header = { type: "session_meta", payload: { id: "thread-test", cwd } };
  const call = {
    type: "response_item",
    timestamp,
    payload: {
      type: "custom_tool_call",
      id: "native-call",
      call_id: "custom-1",
      name: "apply_patch",
      input: "synthetic patch",
    },
  };
  const reply = {
    type: "response_item",
    timestamp,
    payload: {
      type: "custom_tool_call_output",
      call_id: "custom-1",
      output: "Success",
    },
  };
  await fs.writeFile(
    file,
    [header, call, reply].map((e) => JSON.stringify(e)).join("\n") + "\n"
  );
  const [ref] = await source.discover(cwd);
  const first = await source.readSince(ref, null);
  expect(first.messages).toHaveLength(2);
  expect(JSON.parse(first.messages[0].content)).toMatchObject({
    method: "item/started",
    params: { item: { type: "apply_patch", input: "synthetic patch" } },
  });
  await fs.writeFile(
    file,
    [
      header,
      { ...call, timestamp: "2026-09-15T00:00:00Z" },
      { ...reply, timestamp: "2026-09-15T00:00:00Z" },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n") + "\n"
  );
  const replay = await source.readSince(ref, null);
  expect(replay.messages.map((m) => m.sourceEntryId)).toEqual(
    first.messages.map((m) => m.sourceEntryId)
  );
});
it("reads forked rollout history across restart without accepting unrelated identity or workspace changes", async () => {
  const file = path.join(dir, "2026/09/14/rollout-fork.jsonl");
  const line = (value: unknown) => JSON.stringify(value) + "\n";
  const header = line({ type: "session_meta", payload: { id: "child", cwd, forked_from_id: "parent" } });
  const parent = line({ type: "session_meta", payload: { id: "parent", cwd } });
  const message = line({ type: "response_item", timestamp, payload: {
    id: "inherited", type: "message", role: "user", content: [{ type: "input_text", text: "Inherited prompt" }],
  } });
  await fs.writeFile(file, header + parent + message);
  const options = { rootDir: dir, maxReadBytes: 1, now: () => new Date(timestamp) };
  await source.dispose();
  source = new CodexSource(options);
  const [ref] = await source.discover(cwd);
  expect(ref).toMatchObject({ externalId: "child", workspacePath: cwd });
  const first = await source.readSince(ref, null);
  expect(first.messages).toEqual([]);
  await source.dispose();
  source = new CodexSource(options);
  const rest = await drain(source, ref, first.cursor);
  expect(rest.messages).toHaveLength(1);
  expect(rest.messages[0].content).toContain("Inherited prompt");
  const replay = await drain(source, ref);
  expect(replay.messages.map(m => m.sourceEntryId)).toEqual(rest.messages.map(m => m.sourceEntryId));

  // An appended identity change is not inherited fork metadata.
  await fs.appendFile(file, parent);
  await expect(drain(source, ref, rest.cursor)).rejects.toThrow("identity changed");
  await fs.writeFile(file, header + parent.replace('"parent"', '"unrelated"') + message);
  await expect(drain(source, ref)).rejects.toThrow("identity changed");
  await fs.writeFile(file, header + parent.replace(cwd, "/foreign") + message);
  await expect(drain(source, ref)).rejects.toThrow("cwd changed");
});

it("eventually visits every eligible file with a one-entry discovery budget", async () => {
  await source.dispose();
  source = new CodexSource({
    ...{ now: () => new Date(timestamp) },
    rootDir: dir,
    maxDiscoveryEntries: 1,
  });
  for (let i = 0; i < 3; i++)
    await fs.writeFile(
      path.join(dir, `2026/09/14/rollout-${i}.jsonl`),
      JSON.stringify({
        type: "session_meta",
        payload: { id: `thread-${i}`, cwd },
      }) + "\n"
    );
  const found = new Set<string>();
  for (let i = 0; i < 10; i++) {
    const refs = await source.discover(cwd);
    expect(refs.length).toBeLessThanOrEqual(1);
    refs.forEach((r) => found.add(r.externalId));
  }
  expect([...found].sort()).toEqual(["thread-0", "thread-1", "thread-2"]);
});

it("does not reread a rejected foreign header on every append, but invalidates on rotation", async () => {
  const file = path.join(dir, "2026/09/14/rollout-cached.jsonl");
  const foreign =
    JSON.stringify({
      type: "session_meta",
      payload: { id: "foreign", cwd: "/other" },
    }) + "\n";
  await fs.writeFile(file, foreign);
  const reads = vi.spyOn(reader, "readJsonl");
  expect(await source.discover(cwd)).toEqual([]);
  expect(reads).toHaveBeenCalledTimes(1);
  await fs.appendFile(file, '{"type":"event_msg","payload":{}}\n');
  expect(await source.discover(cwd)).toEqual([]);
  expect(reads).toHaveBeenCalledTimes(1);
  await fs.rename(file, file + ".old");
  await fs.writeFile(
    file,
    JSON.stringify({ type: "session_meta", payload: { id: "local", cwd } }) +
      "\n"
  );
  expect(await source.discover(cwd)).toMatchObject([{ externalId: "local" }]);
  expect(reads).toHaveBeenCalledTimes(2);
});
it("maps current ordinal rollouts to the same canonical command/file/MCP output as live app-server items", async () => {
  await source.dispose();
  source = new CodexSource({
    ...{ now: () => new Date(timestamp) },
    rootDir: dir,
  });
  const file = path.join(dir, "2026/09/14/rollout-current.jsonl");
  await fs.copyFile(
    path.join(__dirname, "fixtures/codex-rollout-typed.jsonl"),
    file
  );
  const [ref] = await source.discover(cwd);
  const actual = await drain(source, ref);
  expect(actual.messages).toHaveLength(5);
  const date = new Date(timestamp);
  const context: ParseContext = {
    sessionId: "local",
    hasToolCall: () => false,
    hasSubagent: () => false,
    findByProviderToolCallId: async () => null,
    findActiveToolCallByRawProviderId: async () => null,
  };
  const canonical = async (messages: typeof actual.messages) => {
    const parser = new CodexRawParserDispatcher();
    const result = [];
    for (const [i, message] of messages.entries())
      result.push(
        ...(await parser.parseMessage(
          {
            ...message,
            metadata: message.metadata ?? undefined,
            id: i + 1,
            sessionId: "local",
            source: "openai-codex",
            createdAt: date,
          },
          context
        ))
      );
    return result;
  };
  // Golden live envelopes use the parser's public transport contract, independently
  // of the rollout adapter. Full event equality covers tool widgets and linkage.
  const liveItems = [
    {
      id: "cmd",
      type: "commandExecution",
      command: "cat hello.txt",
      status: "completed",
      aggregated_output: "hello",
      exit_code: 0,
    },
    {
      id: "edit",
      type: "fileChange",
      status: "completed",
      changes: [
        {
          path: "hello.txt",
          kind: { type: "update", move_path: null },
          diff: "-hello\n+world",
        },
      ],
    },
    {
      id: "mcp",
      type: "mcpToolCall",
      server: "files",
      tool: "list",
      arguments: { path: "." },
      status: "completed",
      result: {
        content: [{ type: "text", text: "hello.txt" }],
        isError: false,
      },
    },
  ];
  const liveMessages = liveItems.map((item) => ({
    sourceEntryId: item.id,
    direction: "output" as const,
    content: JSON.stringify({
      method: "item/completed",
      params: { threadId: ref.externalId, item },
    }),
    metadata: { transport: "app-server", editGroupId: `nimtc|${item.id}|0|0` },
    timestamp,
  }));
  const actualEvents = await canonical(actual.messages);
  expect(actualEvents[0]).toMatchObject({
    type: "user_message",
    text: "Inspect and edit",
  });
  expect(actualEvents[actualEvents.length - 1]).toMatchObject({
    type: "assistant_message",
    text: "Done",
  });
  expect(actualEvents.slice(1, -1)).toEqual(await canonical(liveMessages));
  expect(actualEvents.slice(1, -1)).toHaveLength(6);
});

it("separates bounded live date discovery from all-workspace historical manual pages and directly retries incomplete headers", async () => {
  await source.dispose();
  source = new CodexSource({
    ...{ now: () => new Date(timestamp) },
    rootDir: dir,
    maxDiscoveryEntries: 2,
    now: () => new Date(timestamp),
  });
  const oldFile = path.join(dir, "2025/01/01/rollout-old.jsonl");
  await fs.mkdir(path.dirname(oldFile), { recursive: true });
  await fs.writeFile(
    oldFile,
    JSON.stringify({
      type: "session_meta",
      payload: { id: "old", cwd: "/historical" },
    }) +
      "\n" +
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Old prompt" }],
        },
      })
  );
  for (let i = 0; i < 10; i++)
    expect(await source.discover("/historical")).toEqual([]);
  const sessions = [];
  for (let i = 0; i < 20; i++) {
    const page = await source.discoverPage();
    sessions.push(...page.sessions);
    if (!page.hasMore) break;
  }
  expect(sessions).toMatchObject([
    { externalId: "old", workspacePath: "/historical", title: "Old prompt..." },
  ]);
  expect(
    (await source.readSince(sessions[0], null, { includeFinalLine: true }))
      .messages
  ).toHaveLength(1);
  const file = path.join(dir, "2026/09/14/rollout-partial.jsonl");
  await fs.writeFile(file, '{"type":"session_meta","payload":');
  expect(await source.identify(file, [cwd])).toBeNull();
  await fs.appendFile(file, JSON.stringify({ id: "fresh", cwd }) + "}\n");
  expect(await source.identify(file, ["/other", cwd])).toMatchObject({
    externalId: "fresh",
    workspacePath: cwd,
  });
});

async function drain(
  target: CodexSource,
  ref: import("../types").ExternalSessionRef,
  cursor: import("../types").ExternalCursor | null = null
) {
  const messages: import("../types").ExternalRawMessage[] = [];
  for (let i = 0; i < 200; i++) {
    const result = await target.readSince(ref, cursor);
    messages.push(...result.messages);
    cursor = result.cursor;
    if (!result.hasMore) return { messages, cursor };
  }
  throw new Error("Source did not finish bounded reads");
}

it("selects actual coverage across batches, waits for output, and replays safely after restart or failed commit", async () => {
  await source.dispose();
  const options = {
    rootDir: dir,
    maxReadBytes: 64,
    now: () => new Date(timestamp),
  };
  source = new CodexSource(options);
  const file = path.join(dir, "2026/09/14/rollout-coverage.jsonl");
  const header = {
    ordinal: 0,
    type: "session_meta",
    payload: { id: "coverage", cwd },
  };
  const call = {
    type: "response_item",
    payload: {
      type: "function_call",
      call_id: "covered",
      name: "exec_command",
      arguments: '{"cmd":"echo test"}',
    },
  };
  const typed = {
    type: "event_msg",
    payload: {
      type: "item_completed",
      item: {
        id: "typed-command",
        type: "CommandExecution",
        command: "echo test",
        status: "completed",
        aggregated_output: "test",
        exit_code: 0,
      },
    },
  };
  const output = {
    type: "response_item",
    payload: {
      type: "function_call_output",
      call_id: "covered",
      output: "test",
    },
  };
  const line = (e: unknown) => JSON.stringify(e) + "\n";
  await fs.writeFile(file, line(header) + line(call));
  const ref = (await source.identify(file, [cwd]))!;
  const waiting = await drain(source, ref);
  expect(waiting.messages).toEqual([]);
  expect(waiting.cursor.byteOffset).toBe(Buffer.byteLength(line(header)));
  await fs.appendFile(file, line(typed));
  const stillWaiting = await drain(source, ref, waiting.cursor);
  expect(stillWaiting.messages).toEqual([]);
  expect(stillWaiting.cursor.byteOffset).toBe(waiting.cursor.byteOffset);
  await source.dispose();
  source = new CodexSource(options);
  await fs.appendFile(file, line(output));
  const completed = await drain(source, ref, waiting.cursor);
  expect(completed.messages).toHaveLength(1);
  expect(JSON.parse(completed.messages[0].content).params.item.type).toBe(
    "commandExecution"
  );
  // Simulate an append+cursor transaction failure: retry the old durable cursor.
  const retry = await drain(source, ref, waiting.cursor);
  expect(retry.messages.map((m) => m.sourceEntryId)).toEqual(
    completed.messages.map((m) => m.sourceEntryId)
  );
  // A subsequent wrapper-only group in the same file must not inherit typed mode.
  await fs.appendFile(
    file,
    line({ ...call, payload: { ...call.payload, call_id: "uncovered" } }) +
      line({ ...output, payload: { ...output.payload, call_id: "uncovered" } })
  );
  const fallback = await drain(source, ref, completed.cursor);
  expect(fallback.messages).toHaveLength(2);
  expect(JSON.parse(fallback.messages[0].content).method).toBe("item/started");
  expect(JSON.parse(fallback.messages[1].content).type).toBe(
    "nimbalyst_tool_result"
  );
});

it("falls back to every wrapper for overlapping coverage and advances bounded oversized groups", async () => {
  await source.dispose();
  source = new CodexSource({ rootDir: dir, now: () => new Date(timestamp) });
  const file = path.join(dir, "2026/09/14/rollout-overlap.jsonl");
  const header = {
    type: "session_meta",
    ordinal: 0,
    payload: { id: "overlap", cwd },
  };
  const call = (id: string) => ({
    type: "response_item",
    payload: {
      type: "function_call",
      call_id: id,
      name: "inspect",
      arguments: "{}",
    },
  });
  const output = (id: string) => ({
    type: "response_item",
    payload: { type: "function_call_output", call_id: id, output: "done" },
  });
  const typed = {
    type: "event_msg",
    payload: {
      type: "item_completed",
      item: {
        id: "ambiguous-command",
        type: "CommandExecution",
        command: "echo result",
        status: "completed",
      },
    },
  };
  const entries = [
    header,
    call("a"),
    call("b"),
    typed,
    output("a"),
    output("b"),
  ];
  await fs.writeFile(
    file,
    entries.map((e) => JSON.stringify(e)).join("\n") + "\n"
  );
  const ref = (await source.identify(file, [cwd]))!;
  const result = await drain(source, ref);
  expect(result.messages).toHaveLength(4);
  expect(
    result.messages
      .map((m) => JSON.parse(m.content).params?.item?.type)
      .filter(Boolean)
  ).toEqual(["inspect", "inspect"]);
  await source.dispose();
  source = new CodexSource({
    rootDir: dir,
    maxReadBytes: 128,
    maxLineBytes: 512,
  });
  const bounded = await drain(source, ref);
  expect(bounded.messages.map((m) => m.sourceEntryId)).toEqual(
    result.messages.map((m) => m.sourceEntryId)
  );
  // Restart from a committed fallback choice must preserve the same wrapper IDs.
  await source.dispose();
  source = new CodexSource({ rootDir: dir });
  expect(
    (await drain(source, ref)).messages.map((m) => m.sourceEntryId)
  ).toEqual(result.messages.map((m) => m.sourceEntryId));
});

it.each([
  {
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Next request" }],
    },
  },
  {
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Stopped" }],
    },
  },
  { type: "event_msg", payload: { type: "task_complete", turn_id: "done" } },
])(
  "does not strand an abandoned wrapper before a conversation boundary: $type",
  async (boundary) => {
    await source.dispose();
    source = new CodexSource({ rootDir: dir });
    const file = path.join(dir, "2026/09/14/rollout-aborted.jsonl");
    const entries = [
      { type: "session_meta", ordinal: 0, payload: { id: "aborted", cwd } },
      {
        type: "response_item",
        payload: {
          type: "function_call",
          call_id: "aborted-call",
          name: "inspect",
          arguments: "{}",
        },
      },
      boundary,
    ];
    await fs.writeFile(
      file,
      entries.map((e) => JSON.stringify(e)).join("\n") + "\n"
    );
    const ref = (await source.identify(file, [cwd]))!;
    const result = await drain(source, ref);
    expect(
      result.messages.map((m) => JSON.parse(m.content).method).filter(Boolean)
    ).toContain("item/started");
    expect(result.cursor.byteOffset).toBe((await fs.stat(file)).size);
    if (boundary.type === "response_item")
      expect(result.messages).toHaveLength(2);
  }
);

it("flushes an unfinished wrapper at explicit manual EOF and keeps fallback authoritative after restart and later typed append", async () => {
  await source.dispose();
  source = new CodexSource({ rootDir: dir });
  const file = path.join(dir, "2026/09/14/rollout-manual-pending.jsonl");
  const header = {
    type: "session_meta",
    payload: { id: "manual-pending", cwd },
  };
  const call = {
    type: "response_item",
    payload: {
      type: "function_call",
      call_id: "pending",
      name: "inspect",
      arguments: "{}",
    },
  };
  const line = (e: unknown) => JSON.stringify(e) + "\n";
  await fs.writeFile(file, line(header) + line(call));
  const ref = (await source.identify(file, [cwd]))!;
  const manual = await source.readSince(ref, null, { includeFinalLine: true });
  expect(manual.messages).toHaveLength(1);
  expect(manual.cursor.codexFallbackCalls).toEqual(["pending"]);
  expect(manual.hasMore).toBe(false);
  await source.dispose();
  source = new CodexSource({ rootDir: dir });
  await fs.appendFile(
    file,
    line({
      type: "event_msg",
      payload: {
        type: "item_completed",
        item: {
          id: "late-typed",
          type: "CommandExecution",
          command: "echo later",
          status: "completed",
        },
      },
    }) +
      line({
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "pending",
          output: "later",
        },
      })
  );
  const completed = await source.readSince(ref, manual.cursor);
  expect(completed.messages).toHaveLength(1);
  expect(JSON.parse(completed.messages[0].content)).toMatchObject({
    type: "nimbalyst_tool_result",
    result: "later",
  });
  expect(completed.cursor.codexFallbackCalls ?? []).toEqual([]);
});

it("preserves durable fallback while a new bounded group waits, and clears it at a new conversation or rotation", async () => {
  await source.dispose();
  source = new CodexSource({ rootDir: dir });
  const file = path.join(dir, "2026/09/14/rollout-state.jsonl");
  const header = { type: "session_meta", payload: { id: "state", cwd } };
  const call = (id: string) => ({
    type: "response_item",
    payload: {
      type: "function_call",
      call_id: id,
      name: "inspect",
      arguments: "{}",
    },
  });
  const line = (e: unknown) => JSON.stringify(e) + "\n";
  await fs.writeFile(file, line(header) + line(call("old")));
  const ref = (await source.identify(file, [cwd]))!;
  const manual = await source.readSince(ref, null, { includeFinalLine: true });
  await fs.appendFile(file, line(call("new")));
  const waiting = await source.readSince(ref, manual.cursor);
  expect(waiting.messages).toEqual([]);
  expect(waiting.cursor.codexFallbackCalls).toEqual(["old"]);
  await fs.appendFile(
    file,
    line({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "New turn" }],
      },
    }) +
      line({
        type: "event_msg",
        payload: {
          type: "item_completed",
          item: {
            id: "independent",
            type: "CommandExecution",
            command: "new command",
            status: "completed",
          },
        },
      })
  );
  const next = await drain(source, ref, waiting.cursor);
  expect(next.cursor.codexFallbackCalls).toBeUndefined();
  expect(
    next.messages.some(
      (m) => JSON.parse(m.content).params?.item?.id === "independent"
    )
  ).toBe(true);
  await fs.rename(file, file + ".old");
  await fs.writeFile(
    file,
    line(header) +
      line({
        type: "event_msg",
        payload: {
          type: "item_completed",
          item: {
            id: "rotated",
            type: "CommandExecution",
            command: "new file",
            status: "completed",
          },
        },
      })
  );
  const rotated = await source.readSince(ref, manual.cursor);
  expect(rotated.reset).toBe(true);
  expect(rotated.cursor.codexFallbackCalls).toBeUndefined();
  expect(rotated.messages).toHaveLength(1);
  for (const bad of [[""], ["x".repeat(513)], Array(513).fill("id"), 42]) {
    await expect(
      source.readSince(ref, {
        ...rotated.cursor,
        codexFallbackCalls: bad as any,
      })
    ).rejects.toThrow("Invalid Codex fallback");
  }
});

it("flushes a valid unterminated manual tool call while retaining a newline-bound cursor", async () => {
  await source.dispose();
  source = new CodexSource({ rootDir: dir });
  const file = path.join(dir, "2026/09/14/rollout-tool-eof.jsonl");
  const header =
    JSON.stringify({ type: "session_meta", payload: { id: "tool-eof", cwd } }) +
    "\n";
  const call = JSON.stringify({
    type: "response_item",
    payload: {
      type: "function_call",
      call_id: "eof",
      name: "inspect",
      arguments: "{}",
    },
  });
  await fs.writeFile(file, header + call);
  const ref = (await source.identify(file, [cwd]))!;
  const manual = await source.readSince(ref, null, { includeFinalLine: true });
  expect(manual.messages).toHaveLength(1);
  expect(manual.cursor.byteOffset).toBe(Buffer.byteLength(header));
  expect(manual.cursor.codexFallbackCalls).toEqual(["eof"]);
});

it("finds the first prompt after a large header across bounded reads and preserves it", async () => {
  const file = path.join(dir, "2026/09/14/rollout-title.jsonl");
  const line = (value: unknown) => JSON.stringify(value) + "\n";
  await fs.writeFile(
    file,
    line({
      type: "session_meta",
      payload: {
        id: "title",
        cwd,
        instructions: "x".repeat(
          20480 -
            line({
              type: "session_meta",
              payload: { id: "title", cwd, instructions: "" },
            }).length
        ),
      },
    }) +
      line({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Meaningful first prompt" }],
        },
      })
  );
  const ref = (await source.identify(file, [cwd]))!;
  let cursor = null;
  let title: string | undefined;
  for (let i = 0; i < 10; i++) {
    const page = await source.readSince(ref, cursor);
    cursor = page.cursor;
    title = page.title ?? title;
    if (!page.hasMore) break;
  }
  expect(title).toBe("Meaningful first prompt...");
  await fs.appendFile(
    file,
    line({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Second prompt" }],
      },
    })
  );
  const next = await source.readSince(ref, cursor);
  expect(next.title ?? title).toBe(title);
});

it("reuses accepted headers on append and revalidates rewritten cwd and symlink paths", async () => {
  const file = path.join(dir, "2026/09/14/rollout-cache.jsonl");
  const header =
    JSON.stringify({
      type: "session_meta",
      payload: { id: "cache", cwd, instructions: "x".repeat(18000) },
    }) + "\n";
  await fs.writeFile(file, header);
  const ref = (await source.identify(file, [cwd]))!;
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
    file,
    '{"type":"event_msg","payload":{"type":"task_complete"}}\n'
  );
  await source.readSince(ref, first.cursor);
  expect(spy.mock.calls.filter((call) => call[1] === null)).toHaveLength(0);
  expect(realpaths).not.toHaveBeenCalled();
  expect(readBytes).toBeLessThan(50 * 1024);
  await fs.writeFile(
    file,
    header.replace(cwd, "/foreign/workspace") + "\n".repeat(100)
  );
  await expect(source.readSince(ref, first.cursor)).rejects.toThrow(
    "validation"
  );
  await fs.rename(file, file + ".real");
  await fs.symlink(file + ".real", file);
  await expect(source.readSince(ref, first.cursor)).rejects.toThrow(
    "validation"
  );
});

it("reads many completed groups per byte page instead of one roundtrip per tool", async () => {
  await source.dispose();
  source = new CodexSource({ rootDir: dir, maxReadBytes: 32768 });
  const file = path.join(dir, "2026/09/14/rollout-many.jsonl");
  const records: unknown[] = [
    { type: "session_meta", payload: { id: "many", cwd } },
  ];
  for (let i = 0; i < 40; i++)
    records.push(
      {
        type: "response_item",
        payload: {
          type: "function_call",
          call_id: `c${i}`,
          name: "exec_command",
          arguments: "{}",
        },
      },
      {
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: `c${i}`,
          output: "ok",
        },
      }
    );
  await fs.writeFile(
    file,
    records.map((e) => JSON.stringify(e) + "\n").join("")
  );
  const ref = (await source.identify(file, [cwd]))!;
  const page = await source.readSince(ref, null);
  expect(page.messages).toHaveLength(80);
  expect(page.hasMore).toBe(false);
  expect((await source.readSince(ref, null)).messages).toEqual(page.messages);
});

it.each([false, true])(
  "resets same-inode regrowth with a %s fresh source and discards speculative groups",
  async (restart) => {
    const file = path.join(dir, "2026/09/14/rollout-rewrite.jsonl");
    const line = (value: unknown) => JSON.stringify(value) + "\n";
    const header = line({
      type: "session_meta",
      payload: { id: "rewrite", cwd },
    });
    const call = (id: string) =>
      line({
        type: "response_item",
        payload: {
          type: "function_call",
          call_id: id,
          name: "exec_command",
          arguments: "{}",
        },
      });
    await fs.writeFile(file, header);
    const ref = (await source.identify(file, [cwd]))!;
    const initial = await source.readSince(ref, null);
    await fs.appendFile(file, call("old"));
    const pending = await source.readSince(ref, initial.cursor);
    expect(pending.messages).toEqual([]);
    await fs.writeFile(
      file,
      header.replace('"rewrite"', '"rewrite"') +
        call("new") +
        line({
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "new",
            output: "done",
          },
        })
    );
    if (restart) {
      await source.dispose();
      source = new CodexSource({ rootDir: dir });
    }
    const result = await drain(
      source,
      ref,
      JSON.parse(JSON.stringify(pending.cursor))
    );
    expect(result.messages).toHaveLength(2);
    expect(result.messages.map((m) => m.content).join(" ")).not.toContain(
      "old"
    );
  }
);

it("emits completed groups before an incomplete trailing group and flushes only after idle", async () => {
  let now = new Date();
  await source.dispose();
  const options = { rootDir: dir, now: () => now };
  source = new CodexSource(options);
  const file = path.join(dir, "2026/09/14/rollout-idle.jsonl");
  const line = (value: unknown) => JSON.stringify(value) + "\n";
  const header = line({ type: "session_meta", payload: { id: "idle", cwd } });
  const call = (id: string) =>
    line({
      type: "response_item",
      payload: {
        type: "function_call",
        call_id: id,
        name: "inspect",
        arguments: "{}",
      },
    });
  const output = (id: string) =>
    line({
      type: "response_item",
      payload: { type: "function_call_output", call_id: id, output: "ok" },
    });
  const prefix = header + call("done") + output("done");
  await fs.writeFile(file, prefix + call("pending"));
  now = new Date((await fs.stat(file)).mtimeMs + 1000);
  const ref = (await source.identify(file, [cwd]))!;
  const first = await source.readSince(ref, null);
  expect(first.messages).toHaveLength(2);
  expect(first.cursor.byteOffset).toBe(Buffer.byteLength(prefix));
  const waiting = await source.readSince(ref, first.cursor);
  expect(waiting.messages).toEqual([]);
  expect(waiting.hasMore).toBe(false);
  now = new Date(now.getTime() + 30000);
  const idle = await source.readSince(ref, waiting.cursor);
  expect(idle.messages).toHaveLength(1);
  expect(idle.cursor.codexFallbackCalls).toEqual(["pending"]);
  await source.dispose();
  source = new CodexSource(options);
  await fs.appendFile(
    file,
    line({
      type: "event_msg",
      payload: {
        type: "item_completed",
        item: {
          id: "late",
          type: "CommandExecution",
          command: "test",
          status: "completed",
        },
      },
    }) + output("pending")
  );
  const late = await drain(
    source,
    ref,
    JSON.parse(JSON.stringify(idle.cursor))
  );
  expect(late.messages).toHaveLength(1);
  expect(JSON.parse(late.messages[0].content).type).toBe(
    "nimbalyst_tool_result"
  );
  expect(late.cursor.codexFallbackCalls).toBeUndefined();
});

it("invalidates a cached manual result when only its uncommitted EOF tail is rewritten", async () => {
  const file = path.join(dir, "2026/09/14/rollout-tail-rewrite.jsonl");
  const header =
    JSON.stringify({ type: "session_meta", payload: { id: "tail", cwd } }) +
    "\n";
  const call = (id: string) =>
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "function_call",
        call_id: id,
        name: "inspect",
        arguments: "{}",
      },
    });
  await fs.writeFile(file, header + call("old"));
  const ref = (await source.identify(file, [cwd]))!;
  const first = await source.readSince(ref, null, { includeFinalLine: true });
  await fs.writeFile(file, header + call("new"));
  const changed = new Date((await fs.stat(file)).mtimeMs + 1000);
  await fs.utimes(file, changed, changed);
  const next = await source.readSince(ref, null, { includeFinalLine: true });
  expect(next.messages[0].sourceEntryId).not.toBe(
    first.messages[0].sourceEntryId
  );
  expect(next.cursor.codexFallbackCalls).toEqual(["new"]);
});

it("persists cap fallback before later typed records and resumes without duplicate tools", async () => {
  await source.dispose();
  const options = { rootDir: dir, maxReadBytes: 128, maxLineBytes: 512 };
  source = new CodexSource(options);
  const file = path.join(dir, "2026/09/14/rollout-cap.jsonl");
  const line = (value: unknown) => JSON.stringify(value) + "\n";
  const header = line({ type: "session_meta", payload: { id: "cap", cwd } });
  const call = line({
    type: "response_item",
    payload: {
      type: "function_call",
      call_id: "cap-call",
      name: "inspect",
      arguments: "{}",
    },
  });
  const noise = line({
    type: "event_msg",
    payload: { type: "status", padding: "x".repeat(150) },
  });
  await fs.writeFile(file, header + call + noise.repeat(5));
  const ref = (await source.identify(file, [cwd]))!;
  let cursor = null;
  let fallback: import("../types").ExternalCursor | undefined;
  const messages = [];
  for (let i = 0; i < 20; i++) {
    const page = await source.readSince(ref, cursor);
    cursor = page.cursor;
    messages.push(...page.messages);
    if (cursor.codexFallbackCalls?.length) {
      fallback = cursor;
      break;
    }
  }
  expect(messages).toHaveLength(1);
  expect(fallback?.codexFallbackCalls).toEqual(["cap-call"]);
  expect(fallback!.contentMarker).toBe(
    await reader.contentMarkerAt(file, fallback!.byteOffset)
  );
  await source.dispose();
  source = new CodexSource(options);
  await fs.appendFile(
    file,
    line({
      type: "event_msg",
      payload: {
        type: "item_completed",
        item: {
          id: "late-cap",
          type: "CommandExecution",
          command: "test",
          status: "completed",
        },
      },
    }) +
      line({
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "cap-call",
          output: "ok",
        },
      })
  );
  const rest = await drain(source, ref, JSON.parse(JSON.stringify(fallback)));
  expect(rest.messages).toHaveLength(1);
  expect(JSON.parse(rest.messages[0].content).type).toBe(
    "nimbalyst_tool_result"
  );
  expect(rest.cursor.codexFallbackCalls).toBeUndefined();
});

it.each([false, true])(
  "replays replaced committed bytes after same-inode regrowth, restart=%s",
  async (restart) => {
    const file = path.join(dir, "2026/09/14/rollout-committed-rewrite.jsonl");
    const line = (value: unknown) => JSON.stringify(value) + "\n";
    const header = line({
      type: "session_meta",
      payload: { id: "rewrite", cwd },
    });
    const prompt = (text: string) =>
      line({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text }],
        },
      });
    await fs.writeFile(file, header + prompt("old"));
    const ref = (await source.identify(file, [cwd]))!;
    const first = await drain(source, ref);
    await fs.writeFile(file, header + prompt("new") + prompt("later"));
    if (restart) {
      await source.dispose();
      source = new CodexSource({ rootDir: dir });
    }
    const result = await source.readSince(
      ref,
      JSON.parse(JSON.stringify(first.cursor))
    );
    expect(result.reset).toBe(true);
    expect(result.messages.map((m) => JSON.parse(m.content).prompt)).toEqual([
      "new",
      "later",
    ]);
    expect(result.cursor.contentMarker).toBe(
      await reader.contentMarkerAt(file, result.cursor.byteOffset)
    );
  }
);

it("commits the exact complete-line boundary when an idle batch has completed and unfinished groups", async () => {
  await source.dispose();
  source = new CodexSource({
    rootDir: dir,
    now: () => new Date(Date.now() + 60000),
  });
  const file = path.join(dir, "2026/09/14/rollout-idle-boundary.jsonl");
  const records = [
    { type: "session_meta", payload: { id: "idle-boundary", cwd } },
    {
      type: "response_item",
      payload: {
        type: "function_call",
        call_id: "complete",
        name: "inspect",
        arguments: "{}",
      },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "complete",
        output: "ok",
      },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call",
        call_id: "unfinished",
        name: "inspect",
        arguments: "{}",
      },
    },
  ];
  await fs.writeFile(
    file,
    records.map((e) => JSON.stringify(e) + "\n").join("")
  );
  const ref = (await source.identify(file, [cwd]))!;
  const result = await source.readSince(ref, null);
  expect(result.messages).toHaveLength(3);
  expect(result.cursor.byteOffset).toBe((await fs.stat(file)).size);
  expect(result.cursor.contentMarker).toBe(
    await reader.contentMarkerAt(file, result.cursor.byteOffset)
  );
  expect(result.cursor.codexFallbackCalls).toEqual(["unfinished"]);
});

it("uses verified Codex index names for initial and later empty-pass renames, including restart and rotation", async () => {
  await source.dispose();
  const root = path.join(dir, "sessions");
  const file = path.join(root, "2026/09/14/rollout-title-index.jsonl");
  const index = path.join(dir, "session_index.jsonl");
  await fs.mkdir(path.dirname(file), { recursive: true });
  const line = (value: unknown) => JSON.stringify(value) + "\n";
  await fs.writeFile(
    file,
    line({ type: "session_meta", payload: { id: "indexed", cwd } }) +
      line({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Fallback prompt" }],
        },
      })
  );
  await fs.writeFile(
    index,
    line({
      id: "indexed",
      thread_name: "Initial index name",
      updated_at: "2026-09-15T10:00:00Z",
    })
  );
  source = new CodexSource({ rootDir: root });
  const ref = (await source.identify(file, [cwd]))!;
  expect(ref.title).toBe("Initial index name");
  expect(ref.titleKind).toBe("explicit");
  const first = await source.readSince(ref, null);
  await fs.appendFile(
    index,
    line({
      id: "indexed",
      thread_name: "Renamed session",
      updated_at: "2026-09-15T11:00:00Z",
    })
  );
  const renamed = await source.readSince(ref, first.cursor);
  expect(renamed.messages).toEqual([]);
  expect(renamed.title).toBe("Renamed session");
  expect(renamed.titleKind).toBe("explicit");
  await fs.appendFile(
    index,
    line({
      id: "indexed",
      thread_name: "Stale name",
      updated_at: "2026-09-15T09:00:00Z",
    }) + '{"id":"indexed","thread_name":"Partial'
  );
  expect((await source.readSince(ref, first.cursor)).title).toBe(
    "Renamed session"
  );
  await fs.appendFile(index, ' rename","updated_at":"2026-09-15T12:00:00Z"}\n');
  expect((await source.readSince(ref, first.cursor)).title).toBe(
    "Partial rename"
  );
  await source.dispose();
  source = new CodexSource({ rootDir: root });
  expect((await source.readSince(ref, first.cursor)).title).toBe(
    "Partial rename"
  );
  await fs.rename(index, index + ".old");
  await fs.writeFile(
    index,
    line({
      id: "indexed",
      thread_name: "Rotated name",
      updated_at: "2026-09-15T13:00:00Z",
    })
  );
  expect((await source.readSince(ref, first.cursor)).title).toBe(
    "Rotated name"
  );
  await fs.unlink(index);
  await fs.symlink(index + ".old", index);
  expect((await source.readSince(ref, first.cursor)).title).toBe(
    "Fallback prompt..."
  );
  expect(await source.identify(file, ["/foreign/workspace"])).toBeNull();
});

it("bounds index discovery and revisits evicted names without treating the index as session discovery", async () => {
  await source.dispose();
  const root = path.join(dir, "sessions");
  const file = path.join(root, "2026/09/14/rollout-index-many.jsonl");
  const index = path.join(dir, "session_index.jsonl");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(
    file,
    JSON.stringify({ type: "session_meta", payload: { id: "target", cwd } }) +
      "\n"
  );
  await fs.writeFile(
    index,
    Array.from(
      { length: 1400 },
      (_, i) =>
        JSON.stringify({
          id: i === 0 ? "target" : `unrelated-${i}`,
          thread_name: `Name ${i}`,
          updated_at: "2026-09-15T10:00:00Z",
        }) + "\n"
    ).join("")
  );
  source = new CodexSource({ rootDir: root });
  const spy = vi.spyOn(reader, "readJsonl");
  const ref = (await source.identify(file, [cwd]))!;
  let found = ref.title;
  for (let i = 0; i < 6; i++)
    found = (await source.readSince(ref, null)).title ?? found;
  expect(found).toBe("Name 0");
  const calls = spy.mock.calls.filter((call) => call[0] === index);
  expect(calls.length).toBeGreaterThan(0);
  expect(
    calls.every(
      (call) =>
        call[2]?.maxReadBytes === 64 * 1024 &&
        call[2]?.maxLineBytes === 64 * 1024
    )
  ).toBe(true);
  const other = path.join(root, "2026/09/14/rollout-missing-name.jsonl");
  await fs.writeFile(
    other,
    JSON.stringify({ type: "session_meta", payload: { id: "absent", cwd } }) +
      "\n"
  );
  for (let i = 0; i < 5; i++) await source.identify(other, [cwd]);
  let recovered: string | undefined;
  for (let i = 0; i < 5 && !recovered; i++)
    recovered = (await source.identify(file, [cwd]))?.title;
  expect(recovered).toBe("Name 0");
  expect((await source.discoverPage()).sessions).toHaveLength(2);
});

it("marks missing or failed Codex index fallback as weaker than a previously imported explicit name", async () => {
  await source.dispose();
  const root = path.join(dir, "sessions");
  const file = path.join(root, "2026/09/14/rollout-failure-title.jsonl");
  const index = path.join(dir, "session_index.jsonl");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(
    file,
    JSON.stringify({ type: "session_meta", payload: { id: "failure", cwd } }) +
      "\n" +
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Fallback request" }],
        },
      }) +
      "\n"
  );
  await fs.writeFile(
    index,
    JSON.stringify({
      id: "failure",
      thread_name: "Explicit name",
      updated_at: "2026-09-15T12:00:00Z",
    }) + "\n"
  );
  source = new CodexSource({ rootDir: root });
  const ref = (await source.identify(file, [cwd]))!;
  const first = await source.readSince(ref, null);
  expect(first).toMatchObject({
    title: "Explicit name",
    titleKind: "explicit",
  });
  const original = reader.readJsonl;
  const spy = vi
    .spyOn(reader, "readJsonl")
    .mockImplementation(async (...args) => {
      if (args[0] === index)
        throw new Error("EACCES synthetic index read failure");
      return original(...args);
    });
  await fs.appendFile(index, "\n");
  const failed = await source.readSince(ref, first.cursor);
  expect(failed.messages).toEqual([]);
  expect(failed).toMatchObject({
    title: "Fallback request...",
    titleKind: "fallback",
  });
  spy.mockRestore();
  await fs.unlink(index);
  await source.dispose();
  source = new CodexSource({ rootDir: root });
  expect(await source.readSince(ref, first.cursor)).toMatchObject({
    title: "Fallback request...",
    titleKind: "fallback",
  });
});

it("withholds earlier explicit index names until bounded resumed catchup reaches EOF", async () => {
  await source.dispose();
  const root = path.join(dir, "sessions");
  const file = path.join(root, "2026/09/14/rollout-index-catchup.jsonl");
  const index = path.join(dir, "session_index.jsonl");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(
    file,
    JSON.stringify({ type: "session_meta", payload: { id: "catchup", cwd } }) +
      "\n"
  );
  source = new CodexSource({ rootDir: root });
  const ref = (await source.identify(file, [cwd]))!;
  const first = await source.readSince(ref, null);
  const row = (name: string, time: string) =>
    JSON.stringify({ id: "catchup", thread_name: name, updated_at: time }) +
    "\n";
  await fs.writeFile(
    index,
    row("Earlier explicit name", "2026-09-15T10:00:00Z") +
      Array.from(
        { length: 1500 },
        (_, i) =>
          JSON.stringify({
            id: `filler-${i}`,
            thread_name: "Filler",
            updated_at: "2026-09-15T11:00:00Z",
          }) + "\n"
      ).join("") +
      row("Latest explicit name", "2026-09-15T12:00:00Z")
  );
  await source.dispose();
  source = new CodexSource({ rootDir: root });
  const pending = await source.readSince(ref, first.cursor);
  expect(pending.title).toBeUndefined();
  expect(pending.titleKind).toBeUndefined();
  let recovered: string | undefined;
  for (let i = 0; i < 10; i++) {
    const page = await source.readSince(ref, first.cursor);
    expect([undefined, "Latest explicit name"]).toContain(page.title);
    expect(page.titleKind).toBe(page.title ? "explicit" : undefined);
    if (page.title) {
      recovered = page.title;
      break;
    }
  }
  expect(recovered).toBe("Latest explicit name");
});
