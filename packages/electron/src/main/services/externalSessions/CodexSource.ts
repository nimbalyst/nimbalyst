import * as fs from "node:fs/promises";
import * as path from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import {
  BoundedDiscovery,
  AcceptedHeaderCache,
  contentMarkerAt,
  cursorContentMatches,
  DEFAULT_LINE_BYTES,
  type JsonlEntry,
  positiveLimit,
  readJsonl,
  validWorkspace,
  validateSourcePath,
} from "./jsonlReader";
import type {
  ExternalCursor,
  ExternalReadOptions,
  ExternalDiscoveryPage,
  ExternalRawMessage,
  ExternalReadResult,
  ExternalSessionRef,
  ExternalSessionSource,
  ExternalSourceOptions,
} from "./types";

export class CodexSource implements ExternalSessionSource {
  readonly providerId = "openai-codex" as const;
  private readonly root: string;
  private readonly discovery = new BoundedDiscovery();
  private readonly headers = new AcceptedHeaderCache();
  private readonly titleScans = new Map<
    string,
    { cursor: ExternalCursor; title?: string; limit: number }
  >();
  private indexCursor: ExternalCursor | null = null;
  private indexHasMore = true;
  private indexSignature = "";
  private readonly indexNames = new Map<
    string,
    { title: string; updated: number }
  >();

  private readonly pendingIndexRefs = new WeakSet<ExternalSessionRef>();

  private async withIndexTitle(
    ref: ExternalSessionRef
  ): Promise<ExternalSessionRef> {
    const index = await this.indexTitle(ref.externalId);
    const title = index.title ?? ref.title;
    const result: ExternalSessionRef = {
      ...ref,
      title,
      titleKind: title ? (index.title ? "explicit" : "fallback") : undefined,
    };
    if (index.pending) this.pendingIndexRefs.add(result);
    return result;
  }

  /** The index supplies names only; callers have already verified rollout identity/cwd. */
  private async indexTitle(
    id: string
  ): Promise<{ title?: string; pending: boolean }> {
    const parent = path.dirname(this.root);
    const file = path.join(parent, "session_index.jsonl");
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new Error("Invalid Codex title index path");
      await validateSourcePath(parent, file);
      const signature = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
      let selected = this.indexNames.get(id);
      if (!this.indexHasMore && signature === this.indexSignature && selected) {
        this.indexNames.delete(id);
        this.indexNames.set(id, selected);
        return { title: selected.title, pending: false };
      }
      // Missing/evicted names get another bounded traversal after EOF. Retain
      // timestamp-ranked names while cycling so older rows cannot undo renames.
      const cycle = !this.indexHasMore && signature === this.indexSignature;
      const page = await readJsonl(file, cycle ? null : this.indexCursor, {
        maxReadBytes: 64 * 1024,
        maxLineBytes: 64 * 1024,
      });
      if (page.reset) {
        this.indexNames.clear();
        selected = undefined;
      }
      for (const { value: entry } of page.entries) {
        if (
          typeof entry.id !== "string" ||
          !entry.id ||
          entry.id.length > 512 ||
          typeof entry.thread_name !== "string" ||
          !entry.thread_name.trim() ||
          entry.thread_name.length > 4096 ||
          typeof entry.updated_at !== "string"
        )
          continue;
        const updated = Date.parse(entry.updated_at);
        if (!Number.isFinite(updated)) continue;
        const prior =
          this.indexNames.get(entry.id) ??
          (entry.id === id ? selected : undefined);
        if (prior && prior.updated > updated) continue;
        const value = { title: entry.thread_name.trim(), updated };
        if (entry.id === id) selected = value;
        this.indexNames.delete(entry.id);
        this.indexNames.set(entry.id, value);
        if (this.indexNames.size > 512)
          this.indexNames.delete(this.indexNames.keys().next().value!);
      }
      this.indexCursor = page.cursor;
      this.indexHasMore = page.hasMore;
      this.indexSignature = signature;
      // A requested name must survive a page containing more than 512 other IDs.
      if (selected) {
        this.indexNames.delete(id);
        this.indexNames.set(id, selected);
        if (this.indexNames.size > 512)
          this.indexNames.delete(this.indexNames.keys().next().value!);
      }
      return { title: selected?.title, pending: page.hasMore };
    } catch {
      // Missing, malformed or inaccessible optional metadata cannot block messages.
      this.indexCursor = null;
      this.indexHasMore = true;
      this.indexSignature = "";
      this.indexNames.clear();
      return { pending: false };
    }
  }

  private readonly toolGroups = new Map<string, ToolGroup>();
  private readonly foreignHeaders = new Map<
    string,
    { inode: number; size: number; mtimeMs: number }
  >();
  constructor(private readonly options: ExternalSourceOptions = {}) {
    this.root = path.resolve(
      options.rootDir ??
        path.join(
          process.env.CODEX_HOME || path.join(homedir(), ".codex"),
          "sessions"
        )
    );
  }

  watchRoots(workspaces: string[]): string[] {
    if (!workspaces.some(path.isAbsolute)) return [];
    const now = this.options.now?.() ?? new Date();
    const roots = new Set([this.root]);
    for (const date of [now, new Date(now.getTime() - 86400000)]) {
      const [year, month, day] = date.toISOString().slice(0, 10).split("-");
      roots.add(path.join(this.root, year));
      roots.add(path.join(this.root, year, month));
      roots.add(path.join(this.root, year, month, day));
    }
    return [...roots];
  }

  private recentDays(): string[] {
    const now = this.options.now?.() ?? new Date();
    return [now, new Date(now.getTime() - 86400000)].map((date) =>
      path.join(this.root, ...date.toISOString().slice(0, 10).split("-"))
    );
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
    const page = await this.discovery.page(
      `${manual ? "manual" : "live"}:${workspacePath ?? "*"}`,
      manual ? this.root : this.recentDays(),
      manual ? 3 : 0,
      positiveLimit(this.options.maxDiscoveryEntries, 100),
      (relative) => /^\d{4}(?:[/\\]\d{2}){0,2}$/.test(relative)
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
    if (
      !/^\d{4}[/\\]\d{2}[/\\]\d{2}[/\\]rollout-[^/\\]+\.jsonl$/.test(
        path.relative(this.root, filePath)
      )
    )
      return null;
    const cached = await this.headers.get(this.root, filePath, workspacePath);
    if (cached) {
      const scan = this.titleScans.get(filePath);
      if (scan && !scan.title && scan.cursor.byteOffset < scan.limit) {
        const page = await readJsonl(filePath, scan.cursor, {
          ...this.options,
          ...readOptions,
          maxReadBytes: Math.min(
            64 * 1024,
            positiveLimit(this.options.maxReadBytes, 64 * 1024)
          ),
        });
        scan.cursor = page.cursor;
        scan.title = rolloutTitle(page.entries.map((e) => e.value));
      }
      return this.withIndexTitle({
        ...cached,
        title: scan?.title ?? cached.title,
      });
    }
    this.titleScans.delete(filePath);
    try {
      await validateSourcePath(this.root, filePath);
    } catch (error: any) {
      if (error?.code === "ENOENT") throw error;
      return null;
    }
    const stat = await fs.stat(filePath);
    const cacheKey = `${
      workspacePath ? path.resolve(workspacePath) : "*"
    }\x1f${filePath}`;
    const foreign = this.foreignHeaders.get(cacheKey);
    if (
      foreign &&
      foreign.inode === stat.ino &&
      (stat.size > foreign.size ||
        (stat.size === foreign.size && stat.mtimeMs === foreign.mtimeMs))
    ) {
      this.foreignHeaders.delete(cacheKey);
      this.foreignHeaders.set(cacheKey, {
        inode: stat.ino,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      });
      return null;
    }
    this.foreignHeaders.delete(cacheKey);
    const head = await readJsonl(filePath, null, {
      ...this.options,
      ...readOptions,
      maxReadBytes: 4096,
    });
    const meta = head.entries[0]?.value;
    if (
      meta?.type !== "session_meta" ||
      typeof meta.payload?.id !== "string" ||
      !meta.payload.id
    )
      return null;
    if (
      typeof meta.payload.cwd !== "string" ||
      !path.isAbsolute(meta.payload.cwd)
    )
      return null;
    if (
      workspacePath !== undefined &&
      !validWorkspace(meta.payload.cwd, workspacePath)
    ) {
      // Only cache a complete, explicit foreign cwd. A partial header must retry.
      if (
        typeof meta.payload.cwd === "string" &&
        path.isAbsolute(meta.payload.cwd)
      ) {
        this.foreignHeaders.set(cacheKey, {
          inode: stat.ino,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        });
        if (this.foreignHeaders.size > 512)
          this.foreignHeaders.delete(this.foreignHeaders.keys().next().value!);
      }
      return null;
    }
    const ref: ExternalSessionRef = {
      providerId: this.providerId,
      externalId: meta.payload.id,
      workspacePath: path.resolve(meta.payload.cwd),
      filePath,
      updatedAt: stat.mtimeMs,
      title: rolloutTitle(head.entries.map((e) => e.value)),
      ...(typeof meta.payload.forked_from_id === "string" && meta.payload.forked_from_id
        ? {
            codexInheritedMeta: {
              id: meta.payload.forked_from_id,
              byteOffset: head.entries[0].endByteOffset,
            },
          }
        : {}),
      ...(typeof meta.timestamp === "string" &&
      Number.isFinite(Date.parse(meta.timestamp))
        ? { createdAt: Date.parse(meta.timestamp) }
        : {}),
    };
    this.headers.set(ref, head.cursor);
    this.titleScans.set(filePath, {
      cursor: head.cursor,
      title: ref.title,
      limit: head.cursor.byteOffset + 1024 * 1024,
    });
    if (this.titleScans.size > 512)
      this.titleScans.delete(this.titleScans.keys().next().value!);
    return this.withIndexTitle(ref);
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
    if (!inspected || inspected.externalId !== ref.externalId)
      throw new Error("External Codex session reference failed validation");
    const page = await this.readCoveredTools(ref.filePath, cursor, readOptions);
    const messages: ExternalRawMessage[] = [];
    let model: string | undefined;
    for (const record of page.entries) {
      const entry = record.value;
      const payload = entry.payload;
      if (!payload || typeof payload !== "object") continue;
      if (
        (entry.type === "session_meta" || entry.type === "turn_context") &&
        payload.cwd !== undefined &&
        !validWorkspace(payload.cwd, ref.workspacePath)
      )
        throw new Error(
          "External Codex session cwd changed outside its workspace"
        );
      // Forks prepend their own header to copied parent history. Only the
      // declared parent's adjacent metadata is inherited; later identity
      // changes still fail, including after a cursor resume or restart.
      const inheritedMeta = inspected.codexInheritedMeta;
      if (
        entry.type === "session_meta" &&
        payload.id !== ref.externalId &&
        !(inheritedMeta && payload.id === inheritedMeta.id && record.byteOffset === inheritedMeta.byteOffset)
      )
        throw new Error("External Codex session identity changed");
      if (entry.type === "turn_context" && typeof payload.model === "string")
        model = payload.model;
      const nativeId =
        entry.type === "event_msg" &&
        payload.type === "item_completed" &&
        typeof payload.item?.id === "string"
          ? `item_completed:${payload.item.id}`
          : entry.type === "response_item" &&
            typeof payload.call_id === "string"
          ? `${payload.type}:${payload.call_id}`
          : entry.type === "response_item" &&
            typeof payload.id === "string" &&
            payload.id
          ? `${payload.type}:${payload.id}`
          : record.entryId;
      const sourceEntryId = createHash("sha256")
        .update(`${this.providerId}\x1f${ref.externalId}\x1f${nativeId}`)
        .digest("hex");
      const message = rolloutMessage(
        entry,
        ref,
        sourceEntryId,
        record.toolMode
      );
      if (message) messages.push(message);
    }
    return {
      messages,
      cursor: page.cursor,
      reset: page.reset,
      hasMore: page.hasMore,
      model,
      title:
        cursor && this.pendingIndexRefs.has(inspected)
          ? undefined
          : inspected.title,
      titleKind:
        cursor && this.pendingIndexRefs.has(inspected)
          ? undefined
          : inspected.titleKind,
    };
  }

  private async readCoveredTools(
    file: string,
    cursor: ExternalCursor | null,
    options: ExternalReadOptions
  ) {
    const inheritedFallback = normalizeFallbackCalls(
      cursor?.codexFallbackCalls
    );
    const anchor = cursor?.byteOffset ?? 0;
    const stat = await fs.stat(file);
    let group = this.toolGroups.get(file);
    if (
      group &&
      (group.anchor !== anchor ||
        group.inode !== stat.ino ||
        stat.size < group.scan.fileSize ||
        (group.done &&
          (group.scan.fileSize !== stat.size ||
            group.mtimeMs !== stat.mtimeMs)) ||
        !(await cursorContentMatches(file, group.scan)))
    ) {
      this.toolGroups.delete(file);
      group = undefined;
    }
    if (group?.done) return group.done;
    const page = await readJsonl(file, group?.scan ?? cursor, {
      ...this.options,
      ...options,
    });
    if (page.reset && group) {
      this.toolGroups.delete(file);
      group = undefined;
    }
    if (!group)
      group = {
        anchor: page.reset ? 0 : anchor,
        inode: page.cursor.inode,
        scan: page.cursor,
        mtimeMs: stat.mtimeMs,
        records: [],
        open: new Map(),
        groupStart: -1,
        covered: true,
        ambiguous: false,
        reset: page.reset,
        fallbackCalls: new Set(page.reset ? [] : inheritedFallback),
      };
    const cap = positiveLimit(this.options.maxLineBytes, DEFAULT_LINE_BYTES);
    let closed = false;
    let capped = false;
    let end = page.cursor.byteOffset;
    const fallback = () => {
      for (const id of group!.open.keys()) group!.fallbackCalls.add(id);
      normalizeFallbackCalls([...group!.fallbackCalls]);
      if (group!.groupStart >= 0)
        for (let i = group!.groupStart; i < group!.records.length; i++)
          group!.records[i].toolMode = false;
      group!.open.clear();
      closed = true;
    };
    for (const record of page.entries) {
      const p = record.value.payload;
      const kind = wrapperKind(record.value);
      if (record.endByteOffset - group.anchor > cap) {
        if (!group.records.length)
          throw new Error("External JSONL line exceeds byte limit");
        fallback();
        end = Math.min(
          page.cursor.byteOffset,
          group.records[group.records.length - 1].endByteOffset
        );
        capped = true;
        break;
      }
      const coveredRecord: CoveredEntry = { ...record };
      if (isConversationBoundary(record.value)) group.fallbackCalls.clear();
      if (group.fallbackCalls.size && !group.open.size)
        coveredRecord.toolMode = false;
      if (kind === "output") group.fallbackCalls.delete(p.call_id);
      group.records.push(coveredRecord);
      // A later model/user message or explicit terminal event is an observable
      // abandonment boundary. Preserve wrappers and continue the conversation.
      if (group.open.size && isConversationBoundary(record.value)) {
        for (let i = group.groupStart; i < group.records.length; i++)
          group.records[i].toolMode = false;
        group.open.clear();
        end =
          record.endByteOffset <= page.cursor.byteOffset
            ? record.endByteOffset
            : group.anchor;
        closed = true;
        group.groupStart = -1;
        group.covered = true;
        group.ambiguous = false;
        continue;
      }
      if (kind === "start" && !group.fallbackCalls.has(p.call_id)) {
        closed = false;
        if (group.groupStart < 0) group.groupStart = group.records.length - 1;
        if (
          group.open.size ||
          group.fallbackCalls.size ||
          group.open.has(p.call_id)
        )
          group.ambiguous = true;
        if (p.call_id.length > 512)
          throw new Error("External Codex call ID exceeds length limit");
        if (group.open.size >= 512)
          throw new Error("External Codex tool group exceeds call limit");
        group.open.set(p.call_id, false);
      } else if (
        record.value.type === "event_msg" &&
        p?.type === "item_completed" &&
        typedToolItem(p.item)
      ) {
        if (group.open.size === 1)
          group.open.set(group.open.keys().next().value!, true);
        else if (group.open.size) group.ambiguous = true;
      } else if (kind === "output" && group.open.has(p.call_id)) {
        group.covered &&= group.open.get(p.call_id) === true;
        group.open.delete(p.call_id);
        if (!group.open.size) {
          const mode = group.covered && !group.ambiguous;
          for (let i = group.groupStart; i < group.records.length; i++)
            group.records[i].toolMode = mode;
          end =
            record.endByteOffset <= page.cursor.byteOffset
              ? record.endByteOffset
              : group.anchor;
          closed = true;
          group.groupStart = -1;
          group.covered = true;
          group.ambiguous = false;
        }
      }
    }
    if (!group.open.size && !capped) end = page.cursor.byteOffset;
    group.scan = page.cursor;
    group.mtimeMs = stat.mtimeMs;
    const idle =
      (this.options.now?.() ?? new Date()).getTime() - stat.mtimeMs >= 30000;
    if (
      (options.includeFinalLine || idle) &&
      !page.hasMore &&
      group.open.size
    ) {
      fallback();
      end = page.cursor.byteOffset;
    }
    // Commit completed groups before a trailing unresolved one. The uncommitted
    // group is reconstructed from this exact boundary on the next read/restart.
    const prefixCount =
      group.open.size && group.groupStart > 0 ? group.groupStart : 0;
    if (prefixCount) end = group.records[prefixCount].byteOffset;
    const ready = closed || !group.open.size || prefixCount > 0;
    const emitted = ready
      ? prefixCount
        ? group.records.slice(0, prefixCount)
        : group.records
      : [];
    const durableFallback = ready
      ? [...group.fallbackCalls].sort()
      : group.reset
      ? []
      : inheritedFallback;
    const result = {
      entries: emitted,
      cursor: {
        ...page.cursor,
        byteOffset: ready ? end : group.anchor,
        contentMarker:
          (ready ? end : group.anchor) === page.cursor.byteOffset
            ? page.cursor.contentMarker
            : await contentMarkerAt(file, ready ? end : group.anchor),
        ...(durableFallback.length
          ? { codexFallbackCalls: durableFallback }
          : {}),
        lastEntryUuid: ready
          ? emitted.filter((record) => record.endByteOffset <= end).at(-1)
              ?.entryId ??
            cursor?.lastEntryUuid ??
            null
          : cursor?.lastEntryUuid ?? null,
      },
      reset: group.reset,
      hasMore: ready
        ? end > group.anchor &&
          end < page.cursor.fileSize &&
          (closed || prefixCount > 0 || page.hasMore)
        : page.hasMore,
    };
    if (!ready || closed || prefixCount) {
      if (ready) group.done = result;
      this.toolGroups.delete(file);
      this.toolGroups.set(file, group);
      // Eviction loses only a speculative scan. The durable cursor retains all
      // its bytes, so retry/restart safely reconstructs the exact same selection.
      while (
        this.toolGroups.size > 8 ||
        [...this.toolGroups.values()].reduce(
          (n, g) => n + g.scan.byteOffset - g.anchor,
          0
        ) >
          2 * cap
      ) {
        this.toolGroups.delete(this.toolGroups.keys().next().value!);
      }
    } else this.toolGroups.delete(file);
    return result;
  }

  dispose(): Promise<void> {
    this.indexNames.clear();
    this.indexCursor = null;
    this.indexSignature = "";
    this.indexHasMore = true;
    this.headers.clear();
    this.titleScans.clear();
    this.foreignHeaders.clear();
    this.toolGroups.clear();
    return this.discovery.dispose();
  }
}

/** Rollouts are storage records, not app-server notifications. response_item owns
 * conversational content; current typed event items own tool completions. */
function rolloutMessage(
  entry: Record<string, any>,
  ref: ExternalSessionRef,
  sourceEntryId: string,
  usesTypedItems?: boolean
): ExternalRawMessage | null {
  const p = entry.payload;
  const timestamp =
    typeof entry.timestamp === "string" &&
    Number.isFinite(Date.parse(entry.timestamp))
      ? entry.timestamp
      : new Date(0).toISOString();
  const metadata: Record<string, unknown> = { transport: "app-server" };
  const raw = (
    content: unknown,
    direction: "input" | "output" = "output"
  ): ExternalRawMessage => ({
    sourceEntryId,
    direction,
    content: JSON.stringify(content),
    metadata,
    timestamp,
  });
  const itemMessage = (
    item: Record<string, unknown>,
    method = "item/completed"
  ) => {
    metadata.eventType = method;
    return raw({
      method,
      params: {
        threadId: ref.externalId,
        item: { id: sourceEntryId, ...item },
      },
    });
  };
  // Coverage is selected from the actual matching call/output interval, never
  // session version or ordinal. Unknown coverage retains the wrapper pair.
  if (
    usesTypedItems !== false &&
    entry.type === "event_msg" &&
    p.type === "item_completed"
  ) {
    const item = typedToolItem(p.item);
    if (!item) return null;
    if (typeof item.id === "string")
      metadata.editGroupId = toolLookupId(item.id);
    return itemMessage(item);
  }
  if (entry.type !== "response_item") return null;
  if (p.type === "message") {
    const text = textBlocks(p.content);
    if (!text) return null;
    if (p.role === "user")
      return raw(
        { prompt: text, options: { cwd: ref.workspacePath } },
        "input"
      );
    if (p.role === "assistant")
      return itemMessage({ type: "agentMessage", text });
    return null;
  }
  if (p.type === "reasoning") {
    const text = textBlocks(p.summary);
    return text ? itemMessage({ type: "reasoning", text }) : null;
  }
  if (usesTypedItems === true) return null;
  if (p.type === "function_call" || p.type === "custom_tool_call") {
    if (typeof p.call_id !== "string" || typeof p.name !== "string")
      return null;
    const id = p.call_id;
    metadata.editGroupId = toolLookupId(id);
    let args: Record<string, unknown> = {};
    if (p.type === "custom_tool_call") args = { input: p.input };
    else {
      try {
        const parsed = JSON.parse(p.arguments);
        args =
          parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed
            : { input: parsed };
      } catch {
        args = { input: p.arguments };
      }
    }
    // Reserved routing fields cannot be overwritten by arbitrary tool arguments.
    return itemMessage(
      { ...args, id, type: p.name, status: "inProgress" },
      "item/started"
    );
  }
  if (
    p.type === "function_call_output" ||
    p.type === "custom_tool_call_output"
  ) {
    if (typeof p.call_id !== "string") return null;
    // This existing dispatcher shape pairs results without retaining unbounded
    // call-name state across batches or requiring new durable parser state.
    return raw({
      type: "nimbalyst_tool_result",
      tool_use_id: toolLookupId(p.call_id),
      result: p.output,
    });
  }
  if (p.type === "web_search_call")
    return itemMessage({
      ...p,
      id: p.id || sourceEntryId,
      type: "webSearch",
      status: "completed",
    });
  return null;
}

function textBlocks(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .filter((p) => p && typeof p === "object" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n");
}
function toolLookupId(id: string): string {
  return `nimtc|${encodeURIComponent(id)}|0|0`;
}

/** Match storage enum names to the existing app-server transport contract. */
function typedToolItem(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, any>;
  if (typeof item.id !== "string") return null;
  switch (item.type) {
    case "CommandExecution":
      return { ...item, type: "commandExecution" };
    case "McpToolCall":
      return {
        ...item,
        type: "mcpToolCall",
        ...(item.result?.isError
          ? {
              error: {
                message: textBlocks(item.result.content) || "Tool call failed",
              },
            }
          : {}),
      };
    case "FileChange": {
      if (
        !item.changes ||
        typeof item.changes !== "object" ||
        Array.isArray(item.changes)
      )
        return null;
      const changes = Object.entries(item.changes).flatMap(([file, raw]) => {
        if (!raw || typeof raw !== "object") return [];
        const change = raw as Record<string, unknown>;
        if (typeof change.type !== "string") return [];
        return [
          {
            path: file,
            kind: { type: change.type, move_path: change.move_path ?? null },
            diff: change.unified_diff ?? change.content ?? "",
          },
        ];
      });
      return { ...item, type: "fileChange", changes };
    }
    case "WebSearch":
      return { ...item, type: "webSearch" };
    case "ImageView":
      return { ...item, type: "imageView" };
    case "Extension":
      return { ...item, type: "extension" };
    default:
      return null;
  }
}

function rolloutTitle(entries: Record<string, any>[]): string | undefined {
  for (const entry of entries) {
    if (
      entry.type === "response_item" &&
      entry.payload?.type === "message" &&
      entry.payload.role === "user"
    ) {
      const prompt = textBlocks(entry.payload.content);
      if (prompt.trim()) return prompt.slice(0, 50) + "...";
    }
  }
  return undefined;
}

type CoveredEntry = JsonlEntry & { toolMode?: boolean };
interface ToolGroup {
  anchor: number;
  inode: number | null;
  scan: ExternalCursor;
  mtimeMs: number;
  records: CoveredEntry[];
  open: Map<string, boolean>;
  groupStart: number;
  covered: boolean;
  ambiguous: boolean;
  reset: boolean;
  fallbackCalls: Set<string>;
  done?: {
    entries: CoveredEntry[];
    cursor: ExternalCursor;
    reset: boolean;
    hasMore: boolean;
  };
}
function wrapperKind(entry: Record<string, any>): "start" | "output" | null {
  const p = entry.payload;
  if (entry.type !== "response_item" || typeof p?.call_id !== "string")
    return null;
  if (p.type === "function_call" || p.type === "custom_tool_call")
    return "start";
  if (p.type === "function_call_output" || p.type === "custom_tool_call_output")
    return "output";
  return null;
}

function isConversationBoundary(entry: Record<string, any>): boolean {
  const p = entry.payload;
  return (
    (entry.type === "response_item" &&
      p?.type === "message" &&
      (p.role === "user" || p.role === "assistant")) ||
    (entry.type === "event_msg" &&
      ["task_complete", "task_started", "turn_aborted"].includes(p?.type))
  );
}

function normalizeFallbackCalls(value: unknown): string[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length > 512 ||
    value.some((id) => typeof id !== "string" || !id || id.length > 512)
  ) {
    throw new Error("Invalid Codex fallback call cursor");
  }
  return [...new Set(value as string[])].sort();
}
