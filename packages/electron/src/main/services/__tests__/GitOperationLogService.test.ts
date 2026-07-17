import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

vi.mock("electron", () => ({
  app: { getPath: () => os.tmpdir() },
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock("../gitEnv", () => ({
  getGitSubprocessEnv: () => ({ ...process.env }),
}));

import {
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

  it("spawns streamed commands at the resolved repo root, not the workspace subfolder", async () => {
    const repoDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "nim-git-operation-log-repo-"))
    );
    await execFileAsync("git", ["init", "-q"], { cwd: repoDir });
    const subDir = path.join(repoDir, "nested", "sub");
    await fs.mkdir(subDir, { recursive: true });

    try {
      const service = new GitOperationLogService({ rootDir: tmpRoot });
      const result = await runGitCommandStreaming(service, subDir, [
        "rev-parse",
        "--show-toplevel",
      ]);
      const [entry] = await service.list(subDir);

      expect(result.success).toBe(true);
      expect(result.stdout.trim()).toBe(repoDir);
      expect(entry.cwd).toBe(repoDir);
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true });
    }
  });
});
