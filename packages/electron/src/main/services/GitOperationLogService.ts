import { app, BrowserWindow } from "electron";
import { createHash, randomUUID } from "crypto";
import { spawn } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import log from "electron-log/main";
import type {
  GitOperationExecutor,
  GitOperationLogEvent,
  GitOperationLogWireEntry,
  GitOperationSource,
  GitOperationStatus,
} from "@nimbalyst/extension-sdk/git-operation-log";
import { getGitSubprocessEnv } from "./gitEnv";

export type {
  GitOperationExecutor,
  GitOperationLogEvent,
  GitOperationSource,
  GitOperationStatus,
};
export type GitOutputStream = "stdout" | "stderr";

/**
 * The journal's in-memory shape is the wire shape: every field here crosses IPC
 * to the Git panel and the menu-bar indicator. Keeping one definition (in the
 * SDK, which both consumers can import) is what stops the two surfaces from
 * drifting apart on what a running operation looks like.
 */
export type GitOperationLogEntry = GitOperationLogWireEntry;

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

// Git and the hooks it runs colour their output even when stdout is a pipe,
// and the Output panel renders plain text -- so a failing pre-push test would
// arrive as literal "[32m- Expected[39m" noise. Built from escape sequences
// rather than a literal to keep raw control bytes out of this source file.
const ANSI_ESCAPE_PATTERN = new RegExp(
  "\\u001B\\[[0-9;?]*[ -/]*[@-~]" + // CSI (colour, cursor)
    "|\\u001B\\][\\s\\S]*?(?:\\u0007|\\u001B\\\\)" + // OSC (title), BEL- or ST-terminated
    "|\\u001B[@-Z\\\\^_]", // single-character escapes
  "g"
);

function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE_PATTERN, "");
}

/** Output/error text bound for the panel: colours removed, secrets masked. */
function sanitizeOutputText(value: string): string {
  return redactSensitiveText(stripAnsi(value));
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

/**
 * Journal identity for an observed (externally executed) command.
 *
 * Keyed on the session plus the provider's tool-call id rather than a fresh
 * UUID, so the provider's repeated start events and its later completion all
 * address one entry. Codex reuses raw item ids like `item_0` across turns, so
 * callers must pass the stable synthetic id, not the raw one.
 */
export function externalEntryId(
  sessionId: string,
  providerToolCallId: string
): string {
  return `ext:${sessionId}:${providerToolCallId}`;
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
  private readonly terminalListeners = new Set<
    (workspacePath: string, entry: GitOperationLogEntry) => void
  >();

  constructor(options: GitOperationLogServiceOptions = {}) {
    this.rootDir = options.rootDir;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.compactThresholdBytes =
      options.compactThresholdBytes ?? DEFAULT_COMPACT_THRESHOLD_BYTES;
    this.broadcast = options.broadcast ?? defaultBroadcast;
    this.now = options.now ?? Date.now;
  }

  /**
   * Observe operations reaching a terminal state (success, error, interrupted).
   *
   * The journal is where every foreground Git operation already converges, so it
   * is the one place that knows "something just finished in this repository" --
   * which is what the status refresh needs. Kept as a listener rather than a
   * direct call so this service stays unaware of Git status reading.
   */
  onOperationTerminal(
    listener: (workspacePath: string, entry: GitOperationLogEntry) => void
  ): () => void {
    this.terminalListeners.add(listener);
    return () => {
      this.terminalListeners.delete(listener);
    };
  }

  private emitTerminal(
    workspacePath: string,
    entry: GitOperationLogEntry
  ): void {
    for (const listener of this.terminalListeners) {
      try {
        listener(workspacePath, this.project(entry));
      } catch (error) {
        // Observability must never take down the operation that triggered it.
        log.error("[GitOperationLog] Terminal listener failed:", error);
      }
    }
  }

  async list(workspacePath: string): Promise<GitOperationLogEntry[]> {
    this.requireWorkspacePath(workspacePath);
    const state = await this.ensureLoaded(workspacePath);
    return state.entries.map((entry) => this.project(entry));
  }

  /**
   * Copy an entry for a consumer outside this service, filling in metadata that
   * postdates the journal format. Journals written before agent activity existed
   * only ever held app-owned direct `git` invocations, so that is what an absent
   * `source`/`executor` means -- resolved on the way out rather than by
   * rewriting a file the user may still be appending to.
   */
  private project(entry: GitOperationLogEntry): GitOperationLogEntry {
    return {
      ...entry,
      args: [...entry.args],
      source: entry.source ?? "nimbalyst",
      executor: entry.executor ?? "git",
    };
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
      source: "nimbalyst",
      executor: "git",
    };

    state.entries.push(entry);
    this.trimEntries(state);
    await this.queueEvent(workspacePath, state, {
      version: 1,
      type: "start",
      entry,
    });
    this.emitUpsert(workspacePath, entry);
    return this.project(entry);
  }

  /**
   * Record a Git command Nimbalyst observed but did not spawn -- today, an agent
   * shell tool call whose command line invokes Git.
   *
   * Idempotent on `(sessionId, providerToolCallId)` because providers re-emit a
   * tool call's start: Codex sends both `item.started` and `item.completed` for
   * one `command_execution`, and a duplicate start must upsert the same entry
   * rather than leave a phantom running forever.
   *
   * Deliberately does NOT take `GitOperationLock`: we are watching someone
   * else's process, and holding a lock we cannot use to stop it would only
   * stall the user's own Git actions behind an agent command.
   */
  async startExternal(input: {
    workspacePath: string;
    command: string;
    source: GitOperationSource;
    sessionId: string;
    provider?: string;
    providerToolCallId: string;
  }): Promise<GitOperationLogEntry> {
    this.requireWorkspacePath(input.workspacePath);
    const state = await this.ensureLoaded(input.workspacePath);
    const id = externalEntryId(input.sessionId, input.providerToolCallId);

    const existing = state.entries.find((candidate) => candidate.id === id);
    if (existing) return this.project(existing);

    const timestamp = this.now();
    const entry: GitOperationLogEntry = {
      id,
      timestamp,
      updatedAt: timestamp,
      // The provider lifecycle only proves the whole tool call is running, so
      // show the whole (redacted) command line. Claiming a specific child
      // segment is active at a given instant would be a guess.
      command: redactSensitiveText(stripAnsi(input.command)).trim(),
      executable: "git",
      // Empty: this was not invoked as a direct `git` child with these args.
      args: [],
      cwd: input.workspacePath,
      status: "running",
      output: "",
      stdout: "",
      stderr: "",
      source: input.source,
      executor: "shell",
      sessionId: input.sessionId,
      provider: input.provider,
      providerToolCallId: input.providerToolCallId,
    };

    state.entries.push(entry);
    this.trimEntries(state);
    await this.queueEvent(input.workspacePath, state, {
      version: 1,
      type: "start",
      entry,
    });
    this.emitUpsert(input.workspacePath, entry);
    return this.project(entry);
  }

  /** Terminalize an observed command. Duplicate terminal events are harmless. */
  async finishExternal(input: {
    workspacePath: string;
    sessionId: string;
    providerToolCallId: string;
    success: boolean;
    output?: string;
    error?: string;
    exitCode?: number;
  }): Promise<GitOperationLogEntry | undefined> {
    const id = externalEntryId(input.sessionId, input.providerToolCallId);
    if (input.output) {
      this.appendOutput(input.workspacePath, id, "stdout", input.output);
    }
    return this.finish(input.workspacePath, id, {
      success: input.success,
      exitCode: input.exitCode,
      error: input.error,
    });
  }

  /**
   * Mark an observed command interrupted, for when the session is cancelled or
   * the provider disconnects. Without this the entry waits for a result that
   * will never arrive and reads as "still running" until the next app restart.
   */
  async interruptExternal(input: {
    workspacePath: string;
    sessionId: string;
    providerToolCallId: string;
    reason?: string;
  }): Promise<GitOperationLogEntry | undefined> {
    const id = externalEntryId(input.sessionId, input.providerToolCallId);
    return this.finish(input.workspacePath, id, {
      success: false,
      error:
        input.reason ??
        "The agent session ended before this command reported a final status.",
      interrupted: true,
    });
  }

  /**
   * Terminalize every command still open for a session, across all workspaces
   * it touched.
   *
   * The per-turn sweep in `GitActivityBridge` only runs if the streaming
   * function resumes; a cancelled or stalled provider generator can park while
   * another path settles the session, leaving entries running -- and visibly
   * spinning in the menu-bar indicator -- until the next app restart. This is
   * the backstop, keyed on the session rather than the turn. Idempotent:
   * already-settled entries keep their real outcome.
   */
  async interruptSession(sessionId: string, reason?: string): Promise<void> {
    if (!sessionId) return;
    for (const [workspacePath, state] of this.states) {
      if (!state.loaded) continue;
      const stranded = state.entries.filter(
        (entry) => entry.sessionId === sessionId && entry.status === "running"
      );
      for (const entry of stranded) {
        await this.finish(workspacePath, entry.id, {
          success: false,
          error:
            reason ??
            "The agent session ended before this command reported a final status.",
          interrupted: true,
        });
      }
    }
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

    const safeChunk = sanitizeOutputText(chunk);
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
    result: {
      success: boolean;
      exitCode?: number;
      error?: string;
      interrupted?: boolean;
    }
  ): Promise<GitOperationLogEntry | undefined> {
    const state = await this.ensureLoaded(workspacePath);
    const entry = state.entries.find((candidate) => candidate.id === id);
    if (!entry) return undefined;
    // Providers re-emit terminal events; the first outcome is the real one, and
    // re-finishing would restate duration and re-trigger the status refresh.
    if (entry.status !== "running") return this.project(entry);

    const at = this.now();
    entry.updatedAt = at;
    entry.status = result.interrupted
      ? "interrupted"
      : result.success
        ? "success"
        : "error";
    entry.exitCode = result.exitCode;
    entry.error = result.error ? sanitizeOutputText(result.error) : undefined;
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
    this.emitTerminal(workspacePath, entry);
    return this.project(entry);
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
      entry: this.project(entry),
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

/**
 * A `close` with no exit code means git was terminated by a signal, not that
 * it finished. Reporting the captured stderr in that case is misleading: a
 * push whose pre-push hook had fully passed died this way on 2026-09-11, and
 * the panel showed the hook's own noise as if the hook had rejected it. Only
 * the signal name says what happened (SIGHUP from a pty teardown, SIGTERM
 * from a lock cleanup, SIGKILL from the OS), so it leads the message and the
 * last lines of output follow for context.
 */
export function describeSignalExit(
  args: string[],
  signal: string,
  stderr: string
): string {
  const tail = stderr
    .trim()
    .split("\n")
    .filter((line) => !line.startsWith("    at "))
    .slice(-12)
    .join("\n");
  const command = ["git", ...args.slice(0, 1)].join(" ");
  return (
    `${command} was terminated by ${signal} before it finished. ` +
    `Its hooks did not reject it; another process signalled git.` +
    (tail ? `\n\nLast output:\n${tail}` : "")
  );
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
      const chunk = sanitizeOutputText(data.toString());
      stdout = capOutput(stdout, chunk, DEFAULT_MAX_OUTPUT_BYTES);
      service.appendOutput(workspacePath, entry.id, "stdout", chunk);
    });
    child.stderr.on("data", (data: Buffer | string) => {
      const chunk = sanitizeOutputText(data.toString());
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
    child.once("close", (code, signal) => {
      void settle(
        code ?? -1,
        code === null && signal
          ? describeSignalExit(args, signal, stderr)
          : undefined
      );
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

/**
 * Record a user-visible Git operation that is not a single `git` child process.
 *
 * `withGitOperationLog` requires the operation to report `{ success }`; the
 * worktree services throw on failure and return domain objects otherwise, so
 * this variant treats "did not throw" as success. `args` is the operation the
 * user asked for, in Git's own vocabulary -- the same convention the commit
 * handler already uses for its multi-step stage-then-commit.
 */
export async function recordGitActivity<T>(
  service: GitOperationLogService,
  workspacePath: string,
  args: string[],
  operation: () => Promise<T>,
  formatOutput?: (result: T) => string | undefined
): Promise<T> {
  const entry = await service.start(workspacePath, args);
  try {
    const result = await operation();
    const output = formatOutput?.(result);
    if (output)
      service.appendOutput(workspacePath, entry.id, "stdout", `${output}\n`);
    await service.finish(workspacePath, entry.id, {
      success: true,
      exitCode: 0,
    });
    return result;
  } catch (error) {
    await service.finish(workspacePath, entry.id, {
      success: false,
      exitCode: 1,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

let singleton: GitOperationLogService | null = null;

export function getGitOperationLogService(): GitOperationLogService {
  if (!singleton) singleton = new GitOperationLogService();
  return singleton;
}
