import { app, BrowserWindow } from "electron";
import { createHash, randomUUID } from "crypto";
import { spawn } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import log from "electron-log/main";
import { getGitSubprocessEnv } from "./gitEnv";

export type GitOperationStatus =
  | "running"
  | "success"
  | "error"
  | "interrupted";
export type GitOutputStream = "stdout" | "stderr";

export interface GitOperationLogEntry {
  id: string;
  timestamp: number;
  updatedAt: number;
  command: string;
  executable: "git";
  args: string[];
  cwd: string;
  status: GitOperationStatus;
  output: string;
  stdout: string;
  stderr: string;
  error?: string;
  exitCode?: number;
  durationMs?: number;
}

export type GitOperationLogEvent =
  | { workspacePath: string; type: "upsert"; entry: GitOperationLogEntry }
  | { workspacePath: string; type: "clear" };

type JournalEvent =
  | { version: 1; type: "start"; entry: GitOperationLogEntry }
  | {
      version: 1;
      type: "output";
      id: string;
      stream: GitOutputStream;
      chunk: string;
      at: number;
    }
  | {
      version: 1;
      type: "finish";
      id: string;
      status: Exclude<GitOperationStatus, "running">;
      at: number;
      exitCode?: number;
      error?: string;
    }
  | { version: 1; type: "snapshot"; entries: GitOperationLogEntry[] };

interface WorkspaceJournalState {
  loaded: boolean;
  loading?: Promise<void>;
  entries: GitOperationLogEntry[];
  writeChain: Promise<void>;
  estimatedBytes: number;
}

export interface GitOperationLogServiceOptions {
  rootDir?: string;
  maxEntries?: number;
  maxOutputBytes?: number;
  compactThresholdBytes?: number;
  broadcast?: (event: GitOperationLogEvent) => void;
  now?: () => number;
}

const ELISION_MARKER = "\n... output truncated ...\n";
const DEFAULT_MAX_ENTRIES = 100;
const DEFAULT_MAX_OUTPUT_BYTES = 128 * 1024;
const DEFAULT_COMPACT_THRESHOLD_BYTES = 2 * 1024 * 1024;

function defaultBroadcast(event: GitOperationLogEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send("git:operation-log-changed", event);
    }
  }
}

function capOutput(existing: string, chunk: string, maxBytes: number): string {
  const combined = existing + chunk;
  if (Buffer.byteLength(combined, "utf8") <= maxBytes) return combined;

  const markerIndex = existing.indexOf(ELISION_MARKER);
  const existingHead =
    markerIndex >= 0 ? existing.slice(0, markerIndex) : existing;
  const existingTail =
    markerIndex >= 0 ? existing.slice(markerIndex + ELISION_MARKER.length) : "";
  const headBudget = Math.floor(maxBytes * 0.45);
  const tailBudget = Math.max(
    0,
    maxBytes - headBudget - Buffer.byteLength(ELISION_MARKER)
  );
  const head = Buffer.from(existingHead, "utf8")
    .subarray(0, headBudget)
    .toString("utf8");
  const tailSource = Buffer.from(existingTail + chunk, "utf8");
  const tail = tailSource
    .subarray(Math.max(0, tailSource.length - tailBudget))
    .toString("utf8");
  return head + ELISION_MARKER + tail;
}

function redactSensitiveText(value: string): string {
  let redacted = value.replace(/([a-z][a-z0-9+.-]*:\/\/)([^/@\s]+)@/gi, "$1***@");
  redacted = redacted.replace(
    /(authorization\s*:\s*(?:bearer|basic)\s+)[^\s'"\\]+/gi,
    "$1***"
  );
  return redacted;
}

function redactArg(arg: string): string {
  let redacted = redactSensitiveText(arg);
  redacted = redacted.replace(
    /^(--?(?:password|token|oauth-token|access-token|private-token)=).+$/i,
    "$1***"
  );
  if (
    /^(?:http\.)?extraheader=/i.test(redacted) &&
    /authorization\s*:/i.test(redacted)
  ) {
    const equals = redacted.indexOf("=");
    return `${redacted.slice(0, equals + 1)}AUTHORIZATION: ***`;
  }
  return redacted;
}

function quoteDisplayArg(arg: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function formatGitCommand(args: string[]): {
  command: string;
  args: string[];
} {
  const safeArgs = args.map(redactArg);
  return {
    command: ["git", ...safeArgs].map(quoteDisplayArg).join(" "),
    args: safeArgs,
  };
}

export class GitOperationLogService {
  private readonly states = new Map<string, WorkspaceJournalState>();
  private readonly rootDir?: string;
  private readonly maxEntries: number;
  private readonly maxOutputBytes: number;
  private readonly compactThresholdBytes: number;
  private readonly broadcast: (event: GitOperationLogEvent) => void;
  private readonly now: () => number;

  constructor(options: GitOperationLogServiceOptions = {}) {
    this.rootDir = options.rootDir;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.compactThresholdBytes =
      options.compactThresholdBytes ?? DEFAULT_COMPACT_THRESHOLD_BYTES;
    this.broadcast = options.broadcast ?? defaultBroadcast;
    this.now = options.now ?? Date.now;
  }

  async list(workspacePath: string): Promise<GitOperationLogEntry[]> {
    this.requireWorkspacePath(workspacePath);
    const state = await this.ensureLoaded(workspacePath);
    return state.entries.map((entry) => ({ ...entry, args: [...entry.args] }));
  }

  async start(
    workspacePath: string,
    args: string[]
  ): Promise<GitOperationLogEntry> {
    this.requireWorkspacePath(workspacePath);
    const state = await this.ensureLoaded(workspacePath);
    const timestamp = this.now();
    const formatted = formatGitCommand(args);
    const entry: GitOperationLogEntry = {
      id: randomUUID(),
      timestamp,
      updatedAt: timestamp,
      command: formatted.command,
      executable: "git",
      args: formatted.args,
      cwd: workspacePath,
      status: "running",
      output: "",
      stdout: "",
      stderr: "",
    };

    state.entries.push(entry);
    this.trimEntries(state);
    await this.queueEvent(workspacePath, state, {
      version: 1,
      type: "start",
      entry,
    });
    this.emitUpsert(workspacePath, entry);
    return { ...entry, args: [...entry.args] };
  }

  appendOutput(
    workspacePath: string,
    id: string,
    stream: GitOutputStream,
    chunk: string
  ): void {
    const state = this.states.get(workspacePath);
    if (!state?.loaded || !chunk) return;
    const entry = state.entries.find((candidate) => candidate.id === id);
    if (!entry || entry.status !== "running") return;

    const safeChunk = redactSensitiveText(chunk);
    const at = this.now();
    entry.updatedAt = at;
    entry.output = capOutput(entry.output, safeChunk, this.maxOutputBytes);
    entry[stream] = capOutput(entry[stream], safeChunk, this.maxOutputBytes);
    void this.queueEvent(workspacePath, state, {
      version: 1,
      type: "output",
      id,
      stream,
      chunk: safeChunk,
      at,
    });
    this.emitUpsert(workspacePath, entry);
  }

  async finish(
    workspacePath: string,
    id: string,
    result: { success: boolean; exitCode?: number; error?: string }
  ): Promise<GitOperationLogEntry | undefined> {
    const state = await this.ensureLoaded(workspacePath);
    const entry = state.entries.find((candidate) => candidate.id === id);
    if (!entry) return undefined;

    const at = this.now();
    entry.updatedAt = at;
    entry.status = result.success ? "success" : "error";
    entry.exitCode = result.exitCode;
    entry.error = result.error ? redactSensitiveText(result.error) : undefined;
    entry.durationMs = Math.max(0, at - entry.timestamp);
    await this.queueEvent(
      workspacePath,
      state,
      {
        version: 1,
        type: "finish",
        id,
        status: entry.status,
        at,
        exitCode: result.exitCode,
        error: entry.error,
      },
      true
    );
    this.emitUpsert(workspacePath, entry);
    return { ...entry, args: [...entry.args] };
  }

  async clear(workspacePath: string): Promise<void> {
    this.requireWorkspacePath(workspacePath);
    const state = await this.ensureLoaded(workspacePath);
    // Never orphan a command that is still producing output. Clear completed
    // history, then re-emit active entries so renderers remain attached.
    state.entries = state.entries.filter((entry) => entry.status === "running");
    await this.replaceWithSnapshot(workspacePath, state);
    this.broadcast({ workspacePath, type: "clear" });
    for (const entry of state.entries) this.emitUpsert(workspacePath, entry);
  }

  private requireWorkspacePath(workspacePath: string): void {
    if (!workspacePath) throw new Error("workspacePath is required");
  }

  private getJournalPath(workspacePath: string): string {
    const root =
      this.rootDir ?? path.join(app.getPath("userData"), "extension-data");
    const workspaceHash = createHash("sha256")
      .update(workspacePath)
      .digest("hex")
      .slice(0, 16);
    return path.join(
      root,
      "com.nimbalyst.git",
      "workspaces",
      workspaceHash,
      "operation-log.jsonl"
    );
  }

  private async ensureLoaded(
    workspacePath: string
  ): Promise<WorkspaceJournalState> {
    let state = this.states.get(workspacePath);
    if (state?.loaded) return state;
    if (state?.loading) {
      await state.loading;
      return state;
    }
    state = state ?? {
      loaded: false,
      entries: [],
      writeChain: Promise.resolve(),
      estimatedBytes: 0,
    };
    this.states.set(workspacePath, state);

    state.loading = (async () => {
      const journalPath = this.getJournalPath(workspacePath);
      try {
        const raw = await fs.readFile(journalPath, "utf8");
        state.estimatedBytes = Buffer.byteLength(raw, "utf8");
        for (const line of raw.split("\n")) {
          if (!line.trim()) continue;
          try {
            this.applyJournalEvent(state, JSON.parse(line) as JournalEvent);
          } catch {
            // A crash may leave one partial trailing line. Earlier complete events remain valid.
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }

      state.loaded = true;
      let recoveredRunningEntry = false;
      const recoveredAt = this.now();
      for (const entry of state.entries) {
        if (entry.status === "running") {
          entry.status = "interrupted";
          entry.updatedAt = recoveredAt;
          entry.durationMs = Math.max(0, recoveredAt - entry.timestamp);
          entry.error =
            "Nimbalyst exited before this operation reported a final status.";
          recoveredRunningEntry = true;
        }
      }
      this.trimEntries(state);
      if (recoveredRunningEntry) {
        await this.replaceWithSnapshot(workspacePath, state);
      }
    })();
    try {
      await state.loading;
    } finally {
      state.loading = undefined;
    }
    return state;
  }

  private applyJournalEvent(
    state: WorkspaceJournalState,
    event: JournalEvent
  ): void {
    if (event.version !== 1) return;
    if (event.type === "snapshot") {
      state.entries = event.entries.map((entry) => ({
        ...entry,
        args: [...entry.args],
      }));
      return;
    }
    if (event.type === "start") {
      state.entries = state.entries.filter(
        (entry) => entry.id !== event.entry.id
      );
      state.entries.push({ ...event.entry, args: [...event.entry.args] });
      return;
    }
    const entry = state.entries.find((candidate) => candidate.id === event.id);
    if (!entry) return;
    if (event.type === "output") {
      entry.updatedAt = event.at;
      entry.output = capOutput(entry.output, event.chunk, this.maxOutputBytes);
      entry[event.stream] = capOutput(
        entry[event.stream],
        event.chunk,
        this.maxOutputBytes
      );
      return;
    }
    entry.updatedAt = event.at;
    entry.status = event.status;
    entry.exitCode = event.exitCode;
    entry.error = event.error;
    entry.durationMs = Math.max(0, event.at - entry.timestamp);
  }

  private trimEntries(state: WorkspaceJournalState): void {
    if (state.entries.length > this.maxEntries) {
      state.entries = state.entries.slice(-this.maxEntries);
    }
  }

  private emitUpsert(workspacePath: string, entry: GitOperationLogEntry): void {
    this.broadcast({
      workspacePath,
      type: "upsert",
      entry: { ...entry, args: [...entry.args] },
    });
  }

  private async queueEvent(
    workspacePath: string,
    state: WorkspaceJournalState,
    event: JournalEvent,
    compactAfter = false
  ): Promise<void> {
    const line = `${JSON.stringify(event)}\n`;
    state.estimatedBytes += Buffer.byteLength(line, "utf8");
    state.writeChain = state.writeChain.catch(() => undefined).then(async () => {
      const journalPath = this.getJournalPath(workspacePath);
      await fs.mkdir(path.dirname(journalPath), { recursive: true });
      await fs.appendFile(journalPath, line, "utf8");
      if (compactAfter && state.estimatedBytes >= this.compactThresholdBytes) {
        await this.writeSnapshotFile(journalPath, state);
      }
    });
    try {
      await state.writeChain;
    } catch (error) {
      log.error("[GitOperationLog] Failed to append journal event:", error);
    }
  }

  private async replaceWithSnapshot(
    workspacePath: string,
    state: WorkspaceJournalState
  ): Promise<void> {
    state.writeChain = state.writeChain.catch(() => undefined).then(async () => {
      const journalPath = this.getJournalPath(workspacePath);
      await this.writeSnapshotFile(journalPath, state);
    });
    try {
      await state.writeChain;
    } catch (error) {
      log.error("[GitOperationLog] Failed to replace journal snapshot:", error);
    }
  }

  private async writeSnapshotFile(
    journalPath: string,
    state: WorkspaceJournalState
  ): Promise<void> {
    await fs.mkdir(path.dirname(journalPath), { recursive: true });
    const snapshot = `${JSON.stringify({
      version: 1,
      type: "snapshot",
      entries: state.entries,
    })}\n`;
    const tempPath = `${journalPath}.${process.pid}.tmp`;
    await fs.writeFile(tempPath, snapshot, "utf8");
    await fs.rename(tempPath, journalPath);
    state.estimatedBytes = Buffer.byteLength(snapshot, "utf8");
  }
}

export interface RunGitCommandResult {
  success: boolean;
  exitCode: number;
  output: string;
  stdout: string;
  stderr: string;
  error?: string;
}

export async function runGitCommandStreaming(
  service: GitOperationLogService,
  workspacePath: string,
  args: string[]
): Promise<RunGitCommandResult> {
  const entry = await service.start(workspacePath, args);

  return await new Promise<RunGitCommandResult>((resolve) => {
    const child = spawn("git", args, {
      cwd: workspacePath,
      env: getGitSubprocessEnv(),
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    child.stdout.on("data", (data: Buffer | string) => {
      const chunk = redactSensitiveText(data.toString());
      stdout = capOutput(stdout, chunk, DEFAULT_MAX_OUTPUT_BYTES);
      service.appendOutput(workspacePath, entry.id, "stdout", chunk);
    });
    child.stderr.on("data", (data: Buffer | string) => {
      const chunk = redactSensitiveText(data.toString());
      stderr = capOutput(stderr, chunk, DEFAULT_MAX_OUTPUT_BYTES);
      service.appendOutput(workspacePath, entry.id, "stderr", chunk);
    });

    const settle = async (exitCode: number, spawnError?: string) => {
      if (settled) return;
      settled = true;
      const success = exitCode === 0 && !spawnError;
      const error = success
        ? undefined
        : spawnError ||
          stderr.trim() ||
          stdout.trim() ||
          `Git exited with code ${exitCode}`;
      await service.finish(workspacePath, entry.id, {
        success,
        exitCode,
        error,
      });
      resolve({
        success,
        exitCode,
        output: stdout + stderr,
        stdout,
        stderr,
        error,
      });
    };

    child.once("error", (error) => {
      void settle(-1, error.message);
    });
    child.once("close", (code) => {
      void settle(code ?? -1);
    });
  });
}

export async function withGitOperationLog<
  T extends { success: boolean; error?: string }
>(
  service: GitOperationLogService,
  workspacePath: string,
  args: string[],
  operation: (entry: GitOperationLogEntry) => Promise<T>,
  formatOutput?: (result: T) => string | undefined
): Promise<T> {
  const entry = await service.start(workspacePath, args);
  try {
    const result = await operation(entry);
    const output = formatOutput?.(result);
    if (output)
      service.appendOutput(workspacePath, entry.id, "stdout", `${output}\n`);
    await service.finish(workspacePath, entry.id, {
      success: result.success,
      exitCode: result.success ? 0 : 1,
      error: result.error,
    });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await service.finish(workspacePath, entry.id, {
      success: false,
      exitCode: 1,
      error: message,
    });
    throw error;
  }
}

let singleton: GitOperationLogService | null = null;

export function getGitOperationLogService(): GitOperationLogService {
  if (!singleton) singleton = new GitOperationLogService();
  return singleton;
}
