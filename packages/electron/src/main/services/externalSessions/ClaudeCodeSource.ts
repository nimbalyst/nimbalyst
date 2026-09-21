import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { resolveClaudeConfigDir } from "@nimbalyst/runtime/ai/server/providers/claudeCode/claudeConfigDir";
import {
  encodeWorkspaceDir,
  type ClaudeCodeEntry,
} from "../ClaudeCodeSessionScanner";
import {
  entryToMessage,
  importedClaudeCodeModel,
  inlinePersistedOutputsUsing,
  PERSISTED_OUTPUT_PATTERN,
} from "./claudeCodeImportCodec";
import {
  type JsonlEntry,
  BoundedDiscovery,
  AcceptedHeaderCache,
  DEFAULT_READ_BYTES,
  positiveLimit,
  readJsonl,
  validWorkspace,
  validateSourcePath,
} from "./jsonlReader";
import type {
  ExternalCursor,
  ExternalReadOptions,
  ExternalDiscoveryPage,
  ExternalReadResult,
  ExternalSessionRef,
  ExternalSessionSource,
  ExternalSourceOptions,
} from "./types";

type ClaudeTitleState = Partial<
  Record<"custom" | "ai" | "fallback", { value: string; offset: number }>
> & { through: number };

export class ClaudeCodeSource implements ExternalSessionSource {
  readonly providerId = "claude-code" as const;
  private readonly root: string;
  private readonly discovery = new BoundedDiscovery();
  private readonly headers = new AcceptedHeaderCache();
  private readonly titles = new Map<string, ClaudeTitleState>();

  private updateTitle(
    file: string,
    records: JsonlEntry[],
    reset: boolean,
    start: number,
    end: number
  ): string | undefined {
    const state: ClaudeTitleState = reset
      ? { through: 0 }
      : this.titles.get(file) ?? { through: 0 };
    // An EOF read cannot fill an unseen historical gap. Only contiguous reads
    // from the beginning establish which title is authoritative at a saved cursor.
    if ((reset ? 0 : start) <= state.through)
      state.through = Math.max(state.through, end);
    for (const record of records) {
      const entry = record.value;
      for (const [kind, value] of [
        ["custom", entry.customTitle],
        ["ai", entry.aiTitle],
      ] as const) {
        if (
          typeof value === "string" &&
          value.length <= 4096 &&
          value.trim() &&
          (!state[kind] || record.byteOffset >= state[kind]!.offset)
        )
          state[kind] = { value: value.trim(), offset: record.byteOffset };
      }
      if (!state.fallback || record.byteOffset < state.fallback.offset) {
        const fallback = importedTitle([entry]);
        if (fallback && !entry.customTitle && !entry.aiTitle)
          state.fallback = { value: fallback, offset: record.byteOffset };
      }
    }
    this.titles.delete(file);
    this.titles.set(file, state);
    if (this.titles.size > 512)
      this.titles.delete(this.titles.keys().next().value!);
    return state.custom?.value ?? state.ai?.value ?? state.fallback?.value;
  }
  private titleKind(
    file: string,
    title: string | undefined
  ): ExternalSessionRef["titleKind"] {
    if (!title) return undefined;
    const state = this.titles.get(file);
    if (state?.custom?.value === title) return "explicit";
    if (state?.ai?.value === title) return "generated";
    return "fallback";
  }

  constructor(private readonly options: ExternalSourceOptions = {}) {
    this.root = path.resolve(
      options.rootDir ??
        process.env.NIMBALYST_CLAUDE_PROJECTS_DIR ??
        path.join(resolveClaudeConfigDir(), "projects")
    );
  }

  watchRoots(workspaces: string[]): string[] {
    return [
      ...new Set(
        workspaces
          .filter(path.isAbsolute)
          .map((cwd) => path.join(this.root, encodeWorkspaceDir(cwd)))
      ),
    ];
  }

  async identify(
    filePath: string,
    workspacePaths: string[]
  ): Promise<ExternalSessionRef | null> {
    for (const workspace of workspacePaths.filter(path.isAbsolute)) {
      try {
        const ref = await this.inspect(filePath, workspace);
        if (ref) return ref;
      } catch (error: any) {
        if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
      }
    }
    return null;
  }

  async discover(workspacePath: string): Promise<ExternalSessionRef[]> {
    if (!path.isAbsolute(workspacePath)) return [];
    return (await this.scanPage(workspacePath, false)).sessions;
  }

  discoverPage(workspacePath?: string): Promise<ExternalDiscoveryPage> {
    return this.scanPage(workspacePath, true);
  }

  private async scanPage(
    workspacePath: string | undefined,
    manual: boolean
  ): Promise<ExternalDiscoveryPage> {
    if (workspacePath !== undefined && !path.isAbsolute(workspacePath))
      return { sessions: [], hasMore: false };
    const root = workspacePath
      ? path.join(this.root, encodeWorkspaceDir(workspacePath))
      : this.root;
    const page = await this.discovery.page(
      `${manual ? "manual" : "live"}:${workspacePath ?? "*"}`,
      root,
      workspacePath ? 2 : 3,
      positiveLimit(this.options.maxDiscoveryEntries, 100),
      (relative) => {
        const parts = relative.split(path.sep);
        if (!workspacePath) parts.shift();
        return (
          parts.length <= 1 || (parts.length === 2 && parts[1] === "subagents")
        );
      }
    );
    const sessions: ExternalSessionRef[] = [];
    for (const file of page.paths) {
      try {
        const ref = await this.inspect(file, workspacePath, {
          includeFinalLine: manual,
        });
        if (ref) sessions.push(ref);
      } catch (error: any) {
        if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
      }
    }
    return { sessions, hasMore: page.hasMore };
  }

  private async inspect(
    filePath: string,
    workspacePath?: string,
    readOptions: ExternalReadOptions = {}
  ): Promise<ExternalSessionRef | null> {
    if (!path.isAbsolute(filePath)) return null;
    const parts = path.relative(this.root, filePath).split(path.sep);
    const workspaceDir = parts.shift();
    if (
      !workspaceDir ||
      (workspacePath !== undefined &&
        workspaceDir !== encodeWorkspaceDir(workspacePath))
    )
      return null;
    const workspaceRoot = path.join(this.root, workspaceDir);
    let externalId: string;
    let parentToolUseId: string | undefined;
    if (
      parts.length === 1 &&
      parts[0].endsWith(".jsonl") &&
      !parts[0].startsWith("agent-")
    ) {
      externalId = path.basename(filePath, ".jsonl");
    } else if (
      parts.length === 3 &&
      parts[1] === "subagents" &&
      /^agent-.+\.jsonl$/.test(parts[2])
    ) {
      externalId = parts[0];
      parentToolUseId = parts[2].slice(6, -6);
    } else return null;
    if (!externalId || externalId === "." || externalId === "..") return null;
    // A sidecar may omit cwd entirely. Its physical parent log is the only
    // authority for inheritance; the encoded directory is never decoded.
    const parent = parentToolUseId
      ? await this.inspect(
          path.join(workspaceRoot, `${externalId}.jsonl`),
          workspacePath,
          readOptions
        )
      : null;
    if (parentToolUseId && !parent) return null;
    const cached = await this.headers.get(this.root, filePath, workspacePath);
    if (
      cached &&
      (parentToolUseId || this.titles.has(filePath)) &&
      (!parent || validWorkspace(cached.workspacePath, parent.workspacePath))
    ) {
      const delta = await readJsonl(filePath, this.headers.cursor(filePath)!, {
        ...this.options,
        ...readOptions,
        maxReadBytes: Math.min(
          64 * 1024,
          positiveLimit(this.options.maxReadBytes, DEFAULT_READ_BYTES)
        ),
      });
      if (
        delta.entries.some(
          ({ value: e }) =>
            (e.cwd !== undefined &&
              !validWorkspace(e.cwd, cached.workspacePath)) ||
            (e.sessionId !== undefined && e.sessionId !== externalId) ||
            (parentToolUseId
              ? e.agentId !== undefined && e.agentId !== parentToolUseId
              : e.isSidechain === true)
        )
      )
        return null;
      cached.title = parentToolUseId
        ? undefined
        : this.updateTitle(
            filePath,
            delta.entries,
            delta.reset,
            this.headers.cursor(filePath)!.byteOffset,
            delta.cursor.byteOffset
          );
      cached.titleKind = this.titleKind(filePath, cached.title);
      this.headers.set(cached, delta.cursor);
      return cached;
    }
    try {
      await validateSourcePath(this.root, filePath);
    } catch (error: any) {
      if (error?.code === "ENOENT") throw error;
      return null;
    }
    const head = await readJsonl(filePath, null, {
      ...this.options,
      ...readOptions,
      maxReadBytes: Math.min(
        64 * 1024,
        positiveLimit(this.options.maxReadBytes, DEFAULT_READ_BYTES)
      ),
    });
    const entries = head.entries.map((e) => e.value);
    const explicitCwd = entries.find((e) => e.cwd !== undefined)?.cwd;
    const cwd = explicitCwd === undefined ? parent?.workspacePath : explicitCwd;
    if (
      typeof cwd !== "string" ||
      !path.isAbsolute(cwd) ||
      workspaceDir !== encodeWorkspaceDir(cwd)
    )
      return null;
    if (workspacePath !== undefined && !validWorkspace(cwd, workspacePath))
      return null;
    if (parent && !validWorkspace(cwd, parent.workspacePath)) return null;
    if (entries.some((e) => e.cwd !== undefined && !validWorkspace(e.cwd, cwd)))
      return null;
    if (
      entries.some(
        (e) => e.sessionId !== undefined && e.sessionId !== externalId
      )
    )
      return null;
    if (
      parentToolUseId &&
      entries.some(
        (e) => e.agentId !== undefined && e.agentId !== parentToolUseId
      )
    )
      return null;
    if (!parentToolUseId && entries.some((e) => e.isSidechain === true))
      return null;
    const stat = await fs.stat(filePath);
    const title = parentToolUseId
      ? undefined
      : this.updateTitle(
          filePath,
          head.entries,
          true,
          0,
          head.cursor.byteOffset
        );
    const ref: ExternalSessionRef = {
      providerId: this.providerId,
      externalId,
      workspacePath: path.resolve(cwd),
      filePath,
      updatedAt: stat.mtimeMs,
      createdAt: validTime(entries[0]?.timestamp),
      title,
      titleKind: this.titleKind(filePath, title),
      model: importedClaudeCodeModel(entries as ClaudeCodeEntry[]),
      ...(parentToolUseId ? { parentToolUseId } : {}),
    };
    this.headers.set(ref, head.cursor);
    return ref;
  }

  async readSince(
    ref: ExternalSessionRef,
    cursor: ExternalCursor | null,
    readOptions: ExternalReadOptions = {}
  ): Promise<ExternalReadResult> {
    const inspected =
      ref.providerId === this.providerId
        ? await this.inspect(ref.filePath, ref.workspacePath, readOptions)
        : null;
    if (
      !inspected ||
      inspected.externalId !== ref.externalId ||
      inspected.parentToolUseId !== ref.parentToolUseId
    )
      throw new Error("External Claude session reference failed validation");
    const page = await readJsonl(ref.filePath, cursor, {
      ...this.options,
      ...readOptions,
    });
    const messages: ExternalReadResult["messages"] = [];
    let title: string | undefined = ref.parentToolUseId
      ? undefined
      : inspected.title;
    const toolResults = path.join(
      this.root,
      encodeWorkspaceDir(ref.workspacePath),
      ref.externalId,
      "tool-results"
    );
    // A byte budget spans every persisted-output block in this batch.
    let outputBudget = positiveLimit(
      this.options.maxReadBytes,
      DEFAULT_READ_BYTES
    );
    for (const record of page.entries) {
      const entry = record.value as ClaudeCodeEntry;
      if (
        entry.cwd !== undefined &&
        !validWorkspace(entry.cwd, ref.workspacePath)
      )
        throw new Error(
          "External Claude session cwd changed outside its workspace"
        );
      if (entry.sessionId !== undefined && entry.sessionId !== ref.externalId)
        throw new Error("External Claude session identity changed");
      if (
        ref.parentToolUseId &&
        entry.agentId !== undefined &&
        entry.agentId !== ref.parentToolUseId
      )
        throw new Error("External Claude sidecar identity changed");

      await inlinePersistedOutputsUsing(entry, async (text) => {
        const externalPath = text.match(PERSISTED_OUTPUT_PATTERN)?.[1]?.trim();
        if (
          !externalPath ||
          !path.isAbsolute(externalPath) ||
          outputBudget <= 0
        )
          return null;
        try {
          await validateSourcePath(this.root, externalPath);
          await validateSourcePath(toolResults, externalPath);
          const handle = await fs.open(externalPath, "r");
          try {
            const stat = await handle.stat();
            if (!stat.isFile() || stat.size > outputBudget) return null;
            const bytes = Buffer.alloc(stat.size);
            const read = await handle.read(bytes, 0, bytes.length, 0);
            outputBudget -= read.bytesRead;
            return bytes.subarray(0, read.bytesRead).toString("utf8");
          } finally {
            await handle.close();
          }
        } catch {
          return null;
        }
      });
      // Stable fallback time matters when a producer omits timestamps and we replay.
      const message = entryToMessage({
        ...entry,
        timestamp: entry.timestamp ?? new Date(0).toISOString(),
      });
      if (!message) continue;
      if (ref.parentToolUseId) {
        message.content = JSON.stringify({
          ...JSON.parse(message.content),
          parent_tool_use_id: ref.parentToolUseId,
        });
      }
      const sourceEntryId = createHash("sha256")
        .update(
          `${this.providerId}\x1f${ref.externalId}\x1f${path.relative(
            this.root,
            ref.filePath
          )}\x1f${record.entryId}`
        )
        .digest("hex");
      messages.push({ ...message, sourceEntryId });
    }
    if (!ref.parentToolUseId)
      title =
        this.updateTitle(
          ref.filePath,
          page.entries,
          page.reset,
          cursor?.byteOffset ?? 0,
          page.cursor.byteOffset
        ) ?? (page.reset ? undefined : title);
    if (
      !page.reset &&
      cursor &&
      (this.titles.get(ref.filePath)?.through ?? 0) < cursor.byteOffset
    )
      title = undefined;
    return {
      messages,
      cursor: page.cursor,
      reset: page.reset,
      hasMore: page.hasMore,
      title,
      titleKind: this.titleKind(ref.filePath, title),
      model: importedClaudeCodeModel(
        page.entries.map((e) => e.value as ClaudeCodeEntry)
      ),
    };
  }

  dispose(): Promise<void> {
    this.headers.clear();
    this.titles.clear();
    return this.discovery.dispose();
  }
}

function validTime(value: unknown): number | undefined {
  const time = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? time : undefined;
}

function importedTitle(entries: Record<string, any>[]): string | undefined {
  const aiTitle = entries
    .slice()
    .reverse()
    .find((e) => typeof e.aiTitle === "string" && e.aiTitle.trim())?.aiTitle;
  if (aiTitle) return aiTitle;
  for (const entry of entries) {
    const message = entryToMessage(entry as ClaudeCodeEntry);
    if (message?.direction === "input") {
      const prompt = JSON.parse(message.content).prompt;
      if (typeof prompt === "string" && prompt.trim())
        return prompt.slice(0, 50) + "...";
    }
  }
  return undefined;
}
