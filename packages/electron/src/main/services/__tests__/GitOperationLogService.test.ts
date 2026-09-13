import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

vi.mock("electron", () => ({
  app: { getPath: () => os.tmpdir() },
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock("../gitEnv", () => ({
  getGitSubprocessEnv: () => ({ ...process.env }),
}));

import {
  describeSignalExit,
  formatGitCommand,
  GitOperationLogService,
  runGitCommandStreaming,
} from "../GitOperationLogService";

let tmpRoot: string;
let workspacePath: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nim-git-operation-log-"));
  workspacePath = path.join(tmpRoot, "workspace");
  await fs.mkdir(workspacePath);
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("GitOperationLogService", () => {
  it("persists output and terminal state across service instances", async () => {
    let now = 1000;
    const first = new GitOperationLogService({
      rootDir: tmpRoot,
      now: () => now,
    });
    const entry = await first.start(workspacePath, ["push", "origin", "main"]);
    now = 1250;
    first.appendOutput(workspacePath, entry.id, "stdout", "checking hook\n");
    now = 1500;
    await first.finish(workspacePath, entry.id, { success: true, exitCode: 0 });

    const second = new GitOperationLogService({
      rootDir: tmpRoot,
      now: () => 2000,
    });
    const [persisted] = await second.list(workspacePath);

    expect(persisted).toMatchObject({
      command: "git push origin main",
      status: "success",
      stdout: "checking hook\n",
      output: "checking hook\n",
      exitCode: 0,
      durationMs: 500,
    });
  });

  it("recovers operations left running by a previous main process as interrupted", async () => {
    const first = new GitOperationLogService({
      rootDir: tmpRoot,
      now: () => 1000,
    });
    await first.start(workspacePath, ["pull", "--rebase"]);

    // A renderer/panel reload reads the same main-process state and reattaches.
    expect((await first.list(workspacePath))[0].status).toBe("running");

    const second = new GitOperationLogService({
      rootDir: tmpRoot,
      now: () => 1750,
    });
    const [recovered] = await second.list(workspacePath);

    expect(recovered.status).toBe("interrupted");
    expect(recovered.durationMs).toBe(750);
    expect(recovered.error).toContain("exited before this operation reported");
  });

  it("bounds retained entries and large command output", async () => {
    const service = new GitOperationLogService({
      rootDir: tmpRoot,
      maxEntries: 2,
      maxOutputBytes: 80,
    });

    for (const branch of ["one", "two", "three"]) {
      const entry = await service.start(workspacePath, ["checkout", branch]);
      service.appendOutput(workspacePath, entry.id, "stderr", "x".repeat(200));
      await service.finish(workspacePath, entry.id, {
        success: true,
        exitCode: 0,
      });
    }

    const entries = await service.list(workspacePath);
    expect(entries.map((entry) => entry.args.at(-1))).toEqual(["two", "three"]);
    expect(entries[0].output).toContain("output truncated");
    expect(Buffer.byteLength(entries[0].output, "utf8")).toBeLessThanOrEqual(
      80
    );
  });

  it("clears the durable journal", async () => {
    const service = new GitOperationLogService({ rootDir: tmpRoot });
    const entry = await service.start(workspacePath, ["fetch", "origin"]);
    await service.finish(workspacePath, entry.id, { success: true, exitCode: 0 });
    await service.clear(workspacePath);

    const reloaded = new GitOperationLogService({ rootDir: tmpRoot });
    expect(await reloaded.list(workspacePath)).toEqual([]);
  });

  it("keeps a running command attached when completed history is cleared", async () => {
    const service = new GitOperationLogService({ rootDir: tmpRoot });
    const completed = await service.start(workspacePath, ["fetch", "origin"]);
    await service.finish(workspacePath, completed.id, { success: true, exitCode: 0 });
    const running = await service.start(workspacePath, ["push", "origin", "main"]);

    await service.clear(workspacePath);
    service.appendOutput(workspacePath, running.id, "stdout", "hook still running\n");

    const [remaining] = await service.list(workspacePath);
    expect(remaining.id).toBe(running.id);
    expect(remaining.status).toBe("running");
    expect(remaining.output).toContain("hook still running");
  });

  // A fetch moves refs/remotes/* only, which the branch-ref and index watchers
  // never see. The journal's terminal event is the signal that covers it.
  it("announces every terminal outcome so status can refresh", async () => {
    const service = new GitOperationLogService({ rootDir: tmpRoot });
    const seen: Array<{ workspacePath: string; status: string }> = [];
    service.onOperationTerminal((path, entry) => {
      seen.push({ workspacePath: path, status: entry.status });
    });

    const ok = await service.start(workspacePath, ["fetch", "origin"]);
    await service.finish(workspacePath, ok.id, { success: true, exitCode: 0 });
    const failed = await service.start(workspacePath, ["push", "origin", "main"]);
    await service.finish(workspacePath, failed.id, {
      success: false,
      exitCode: 1,
      error: "rejected",
    });

    expect(seen).toEqual([
      { workspacePath, status: "success" },
      // A rejected push can still have moved the index or left conflicts.
      { workspacePath, status: "error" },
    ]);
  });

  it("stamps app-owned operations as direct git and keeps legacy entries readable", async () => {
    const service = new GitOperationLogService({ rootDir: tmpRoot });
    const entry = await service.start(workspacePath, ["fetch", "origin"]);
    expect(entry.source).toBe("nimbalyst");
    expect(entry.executor).toBe("git");

    // A journal written before this metadata existed must project the same way
    // rather than being rewritten on disk.
    const journalPath = path.join(
      tmpRoot,
      "com.nimbalyst.git",
      "workspaces",
    );
    const [hash] = await fs.readdir(journalPath);
    const file = path.join(journalPath, hash, "operation-log.jsonl");
    const raw = await fs.readFile(file, "utf8");
    await fs.writeFile(
      file,
      raw.replace(/,"source":"nimbalyst","executor":"git"/, ""),
      "utf8",
    );

    const reloaded = new GitOperationLogService({ rootDir: tmpRoot });
    const [legacy] = await reloaded.list(workspacePath);
    expect(legacy.source).toBe("nimbalyst");
    expect(legacy.executor).toBe("git");
  });

  it("upserts one entry for duplicate agent start and completion events", async () => {
    const service = new GitOperationLogService({ rootDir: tmpRoot });
    const external = {
      workspacePath,
      command: "git fetch https://user:secret@example.com/repo.git",
      source: "agent" as const,
      sessionId: "session-1",
      providerToolCallId: "call-1",
      provider: "openai-codex",
    };

    await service.startExternal(external);
    await service.startExternal(external);
    await service.finishExternal({
      workspacePath,
      sessionId: "session-1",
      providerToolCallId: "call-1",
      success: true,
      output: "From example.com\n",
      exitCode: 0,
    });
    await service.finishExternal({
      workspacePath,
      sessionId: "session-1",
      providerToolCallId: "call-1",
      success: false,
      error: "late duplicate",
    });

    const entries = await service.list(workspacePath);
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe("success");
    expect(entries[0].source).toBe("agent");
    expect(entries[0].executor).toBe("shell");
    expect(entries[0].sessionId).toBe("session-1");
    // An observed shell command was not invoked as a direct `git` child, so it
    // must not claim a structured argument list.
    expect(entries[0].args).toEqual([]);
    expect(entries[0].command).not.toContain("secret");
    expect(entries[0].output).toContain("From example.com");
  });

  it("interrupts an agent command whose result never arrives", async () => {
    const service = new GitOperationLogService({ rootDir: tmpRoot });
    await service.startExternal({
      workspacePath,
      command: "git push origin main",
      source: "agent",
      sessionId: "session-1",
      providerToolCallId: "call-1",
    });

    await service.interruptExternal({
      workspacePath,
      sessionId: "session-1",
      providerToolCallId: "call-1",
      reason: "cancelled",
    });

    const [entry] = await service.list(workspacePath);
    expect(entry.status).toBe("interrupted");
    expect(entry.error).toBe("cancelled");
  });

  it("interrupts every outstanding command of a session that stopped streaming", async () => {
    // The turn that opened these entries can be abandoned without resuming --
    // a cancelled or stalled provider generator parks while another path settles
    // the session -- so the end-of-turn sweep never runs and the menu-bar
    // indicator spins until the next app restart.
    const service = new GitOperationLogService({ rootDir: tmpRoot });
    for (const providerToolCallId of ["call-1", "call-2"]) {
      await service.startExternal({
        workspacePath,
        command: "git log --oneline -5",
        source: "agent",
        sessionId: "session-1",
        providerToolCallId,
      });
    }
    await service.startExternal({
      workspacePath,
      command: "git status",
      source: "agent",
      sessionId: "session-2",
      providerToolCallId: "call-3",
    });
    await service.finishExternal({
      workspacePath,
      sessionId: "session-1",
      providerToolCallId: "call-2",
      success: true,
      exitCode: 0,
    });

    await service.interruptSession("session-1", "session ended");

    const byId = new Map(
      (await service.list(workspacePath)).map((entry) => [entry.id, entry])
    );
    expect(byId.get("ext:session-1:call-1")?.status).toBe("interrupted");
    // Already settled: the sweep must not restate a real outcome.
    expect(byId.get("ext:session-1:call-2")?.status).toBe("success");
    // Another session's turn may still be live.
    expect(byId.get("ext:session-2:call-3")?.status).toBe("running");
  });

  it("redacts credentials while retaining exact structured arguments", () => {
    expect(
      formatGitCommand([
        "-c",
        "http.extraHeader=Authorization: Bearer secret-token",
        "push",
        "https://user:password@example.com/repo.git",
      ])
    ).toEqual({
      command:
        "git -c 'http.extraHeader=AUTHORIZATION: ***' push 'https://***@example.com/repo.git'",
      args: [
        "-c",
        "http.extraHeader=AUTHORIZATION: ***",
        "push",
        "https://***@example.com/repo.git",
      ],
    });
  });

  it("redacts credentials from persisted command output", async () => {
    const service = new GitOperationLogService({ rootDir: tmpRoot });
    const entry = await service.start(workspacePath, ["fetch", "origin"]);
    service.appendOutput(
      workspacePath,
      entry.id,
      "stderr",
      "fatal: https://user:secret@example.com/repo.git Authorization: Bearer abc123\n"
    );
    await service.finish(workspacePath, entry.id, { success: false, exitCode: 1 });

    const [persisted] = await service.list(workspacePath);
    expect(persisted.stderr).toContain("https://***@example.com/repo.git");
    expect(persisted.stderr).toContain("Authorization: Bearer ***");
    expect(persisted.stderr).not.toContain("secret");
    expect(persisted.stderr).not.toContain("abc123");
  });

  it("strips terminal colour codes from output and errors", async () => {
    // Vitest and Git colour their output even when stdout is a pipe, and the
    // Output panel renders plain text -- so a pre-push failure would otherwise
    // arrive as literal "[32m- Expected[39m" noise.
    const esc = String.fromCharCode(27);
    const service = new GitOperationLogService({ rootDir: tmpRoot });
    const entry = await service.start(workspacePath, ["push", "origin", "main"]);
    service.appendOutput(
      workspacePath,
      entry.id,
      "stderr",
      `${esc}[32m- Expected${esc}[39m\n${esc}[31m+ Received${esc}[39m\n`
    );
    await service.finish(workspacePath, entry.id, {
      success: false,
      exitCode: 1,
      error: `${esc}[31mfatal:${esc}[0m hook rejected the push`,
    });

    const [persisted] = await service.list(workspacePath);
    expect(persisted.stderr).toBe("- Expected\n+ Received\n");
    expect(persisted.error).toBe("fatal: hook rejected the push");
  });

  it("streams real git stdout into the journal before finishing", async () => {
    const events: string[] = [];
    const service = new GitOperationLogService({
      rootDir: tmpRoot,
      broadcast: (event) => {
        if (event.type === "upsert")
          events.push(`${event.entry.status}:${event.entry.output}`);
      },
    });

    const result = await runGitCommandStreaming(service, workspacePath, [
      "--version",
    ]);
    const [entry] = await service.list(workspacePath);

    expect(result.success).toBe(true);
    expect(entry.stdout).toMatch(/^git version /);
    expect(
      events.some((event) => event.startsWith("running:git version "))
    ).toBe(true);
    expect(events.at(-1)).toMatch(/^success:git version /);
  });

  it("names the signal when git dies before exiting, instead of blaming the hook", () => {
    // The hook's stderr right up to the kill looks like a normal passing run.
    const hookStderr = [
      "[pre-push] typecheck:prepush: 86s (exit 0)",
      "Error: Not implemented: navigation (except hash changes)",
      "    at module.exports (jsdom/not-implemented.js:9:17)",
      "[pre-push] test:prepush: 266s (exit 0)",
    ].join("\n");

    const message = describeSignalExit(["push", "origin", "main"], "SIGHUP", hookStderr);

    expect(message).toMatch(/^git push was terminated by SIGHUP before it finished\./);
    expect(message).toContain("another process signalled git");
    // Context survives, stack-trace noise does not.
    expect(message).toContain("[pre-push] test:prepush: 266s (exit 0)");
    expect(message).not.toContain("    at module.exports");
    expect(describeSignalExit(["fetch"], "SIGKILL", "")).not.toContain("Last output");
  });
});
