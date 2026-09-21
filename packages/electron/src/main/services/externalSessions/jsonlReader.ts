import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import type {
  ExternalCursor,
  ExternalSessionRef,
  ExternalSourceOptions,
  ExternalReadOptions,
} from "./types";

export interface JsonlEntry {
  value: Record<string, any>;
  entryId: string;
  byteOffset: number;
  endByteOffset: number;
}

export const DEFAULT_READ_BYTES = 256 * 1024;
export const DEFAULT_LINE_BYTES = 8 * 1024 * 1024;
export function positiveLimit(
  value: number | undefined,
  fallback: number
): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;
}

/** Samples detect replacement at the prefix/resume boundary, not arbitrary interior edits.
 * Manual EOF tails are excluded because offset is always the durable newline boundary. */
async function markerAt(
  handle: fs.FileHandle,
  offset: number
): Promise<string> {
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new Error("Invalid external session cursor");
  const hash = createHash("sha256").update(`external-jsonl-v1:${offset}:`);
  const length = Math.min(4096, offset);
  for (const start of [0, offset - length]) {
    const bytes = Buffer.alloc(length);
    const result = await handle.read(bytes, 0, length, start);
    if (result.bytesRead !== length)
      throw new Error("External JSONL changed during boundary read");
    hash.update(bytes);
  }
  return hash.digest("hex");
}

export async function contentMarkerAt(
  file: string,
  offset: number
): Promise<string> {
  const handle = await fs.open(file, "r");
  try {
    return await markerAt(handle, offset);
  } finally {
    await handle.close();
  }
}

export async function cursorContentMatches(
  file: string,
  cursor: ExternalCursor
): Promise<boolean> {
  if (cursor.contentMarker === undefined) return true;
  if (
    typeof cursor.contentMarker !== "string" ||
    !/^[a-f0-9]{64}$/.test(cursor.contentMarker)
  )
    throw new Error("Invalid external session content marker");
  return (
    (await contentMarkerAt(file, cursor.byteOffset)) === cursor.contentMarker
  );
}

/** No decoder state is persisted: incomplete UTF8 stays in the uncommitted byte tail. */
export async function readJsonl(
  filePath: string,
  cursor: ExternalCursor | null,
  options: ExternalSourceOptions & ExternalReadOptions = {}
) {
  const batchBytes = positiveLimit(options.maxReadBytes, DEFAULT_READ_BYTES);
  const lineBytes = positiveLimit(options.maxLineBytes, DEFAULT_LINE_BYTES);
  const handle = await fs.open(filePath, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile())
      throw new Error("External session source is not a file");
    const inode = stat.ino;
    if (
      cursor?.contentMarker !== undefined &&
      (typeof cursor.contentMarker !== "string" ||
        !/^[a-f0-9]{64}$/.test(cursor.contentMarker))
    )
      throw new Error("Invalid external session content marker");
    const reset =
      !!cursor &&
      ((cursor.inode !== null && cursor.inode !== inode) ||
        stat.size < cursor.fileSize ||
        stat.size < cursor.byteOffset ||
        (cursor.contentMarker !== undefined &&
          (await markerAt(handle, cursor.byteOffset)) !==
            cursor.contentMarker));
    const start = !cursor || reset ? 0 : cursor.byteOffset;
    if (!Number.isSafeInteger(start) || start < 0 || start > stat.size)
      throw new Error("Invalid external session cursor");
    // Read a normal batch, then extend only when its first line crosses the boundary.
    let data = Buffer.alloc(Math.min(batchBytes, lineBytes, stat.size - start));
    const first = await handle.read(data, 0, data.length, start);
    data = data.subarray(0, first.bytesRead);
    while (
      data.indexOf(10) < 0 &&
      start + data.length < stat.size &&
      data.length < lineBytes
    ) {
      const next = Buffer.alloc(
        Math.min(
          batchBytes,
          lineBytes - data.length,
          stat.size - start - data.length
        )
      );
      const read = await handle.read(next, 0, next.length, start + data.length);
      if (!read.bytesRead) break;
      data = Buffer.concat([data, next.subarray(0, read.bytesRead)]);
    }
    if (data.indexOf(10) < 0 && data.length >= lineBytes)
      throw new Error("External JSONL line exceeds byte limit");
    const completeEnd = data.lastIndexOf(10) + 1;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const entries: JsonlEntry[] = [];
    let pos = 0;
    while (pos < completeEnd) {
      const end = data.indexOf(10, pos);
      if (end + 1 - pos > lineBytes)
        throw new Error("External JSONL line exceeds byte limit");
      try {
        const raw = decoder.decode(data.subarray(pos, end));
        const value = JSON.parse(raw);
        if (value && typeof value === "object" && !Array.isArray(value)) {
          // UUID is the native entry identity. Hash fallback retains timestamps/ordinals,
          // unlike byte offsets, which change when a log is compacted or replaced.
          const entryId =
            typeof value.uuid === "string" && value.uuid
              ? value.uuid
              : createHash("sha256").update(raw.trim()).digest("hex");
          entries.push({
            value,
            entryId,
            byteOffset: start + pos,
            endByteOffset: start + end + 1,
          });
        }
      } catch {
        /* A malformed complete line cannot become valid by appending. */
      }
      pos = end + 1;
    }
    if (
      options.includeFinalLine &&
      start + data.length === stat.size &&
      completeEnd < data.length
    ) {
      // A manual snapshot may flush a complete JSON value at EOF, but its cursor
      // still ends at the previous newline. Later newline arrival replays the same
      // identity, so persistence dedupes it instead of losing a subsequent append.
      const after = await handle.stat();
      if (
        after.size !== stat.size ||
        after.mtimeMs !== stat.mtimeMs ||
        after.ino !== stat.ino
      ) {
        throw new Error("External JSONL changed during manual EOF read");
      }
      try {
        const raw = decoder.decode(data.subarray(completeEnd));
        const value = JSON.parse(raw);
        if (value && typeof value === "object" && !Array.isArray(value)) {
          const entryId =
            typeof value.uuid === "string" && value.uuid
              ? value.uuid
              : createHash("sha256").update(raw.trim()).digest("hex");
          entries.push({
            value,
            entryId,
            byteOffset: start + completeEnd,
            endByteOffset: start + data.length,
          });
        }
      } catch {
        /* Incomplete JSON or UTF8 is never flushed, including manually. */
      }
    }
    return {
      entries,
      cursor: {
        byteOffset: start + completeEnd,
        lastEntryUuid:
          entries[entries.length - 1]?.entryId ??
          (reset ? null : cursor?.lastEntryUuid ?? null),
        fileSize: stat.size,
        inode,
        contentMarker:
          !reset &&
          cursor?.contentMarker &&
          start + completeEnd === cursor.byteOffset
            ? cursor.contentMarker
            : await markerAt(handle, start + completeEnd),
      } satisfies ExternalCursor,
      // If we consumed the physical read buffer, remaining bytes may contain more
      // complete lines. An incomplete EOF tail must not schedule an immediate loop.
      hasMore: start + data.length < stat.size,
      reset,
    };
  } finally {
    await handle.close();
  }
}

/** Reject lexical escapes and symlink aliases, including a symlink in an ancestor. */
export async function validateSourcePath(
  root: string,
  file: string
): Promise<void> {
  if (!path.isAbsolute(root) || !path.isAbsolute(file))
    throw new Error("External source references must be absolute");
  const relative = path.relative(path.resolve(root), path.resolve(file));
  if (
    !relative ||
    relative.startsWith(`..${path.sep}`) ||
    relative === ".." ||
    path.isAbsolute(relative)
  )
    throw new Error("External source path is outside its root");
  const [realRoot, realFile] = await Promise.all([
    fs.realpath(root),
    fs.realpath(file),
  ]);
  if (realFile !== path.join(realRoot, relative))
    throw new Error("External source symlink is not allowed");
}

export function validWorkspace(cwd: unknown, expected: string): cwd is string {
  return (
    typeof cwd === "string" &&
    path.isAbsolute(expected) &&
    path.isAbsolute(cwd) &&
    path.resolve(cwd) === path.resolve(expected)
  );
}

/** One yield per visited directory entry lets callers cap IO, including irrelevant files. */
async function* walk(
  root: string,
  depth: number,
  includeDirectory: (relative: string) => boolean,
  prefix = ""
): AsyncGenerator<string | null> {
  let dir;
  try {
    dir = await fs.opendir(path.join(root, prefix));
  } catch (error: any) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  try {
    for await (const entry of dir) {
      const relative = path.join(prefix, entry.name);
      yield entry.isFile() && entry.name.endsWith(".jsonl")
        ? path.join(root, relative)
        : null;
      if (depth > 0 && entry.isDirectory() && includeDirectory(relative))
        yield* walk(root, depth - 1, includeDirectory, relative);
    }
  } finally {
    // for-await closes normally; return() while paused must also close it.
    try {
      await dir.close();
    } catch (error: any) {
      if (error?.code !== "ERR_DIR_CLOSED") throw error;
    }
  }
}

export class BoundedDiscovery {
  private readonly scans = new Map<
    string,
    { signature: string; scan: AsyncGenerator<string | null> }
  >();
  async page(
    key: string,
    roots: string | string[],
    depth: number,
    limit: number,
    includeDirectory: (relative: string) => boolean
  ): Promise<{ paths: string[]; hasMore: boolean }> {
    const rootList = typeof roots === "string" ? [roots] : roots;
    const signature = JSON.stringify(rootList);
    let state = this.scans.get(key);
    if (state && state.signature !== signature) {
      await state.scan.return(undefined);
      this.scans.delete(key);
      state = undefined;
    }
    if (!state) {
      async function* scanRoots() {
        for (const root of rootList) yield* walk(root, depth, includeDirectory);
      }
      state = { signature, scan: scanRoots() };
      this.scans.set(key, state);
    }
    const paths: string[] = [];
    let hasMore = true;
    for (let i = 0; i < limit; i++) {
      const next = await state.scan.next();
      if (next.done) {
        this.scans.delete(key);
        hasMore = false;
        break;
      }
      if (next.value) paths.push(next.value);
    }
    return { paths, hasMore };
  }
  async dispose(): Promise<void> {
    const scans = [...this.scans.values()];
    this.scans.clear();
    await Promise.all(scans.map(({ scan }) => scan.return(undefined)));
  }
}

/** Small accepted-header cache. Hits validate source path components and sampled
 * committed bytes; append growth does not force header JSON decoding again. */
export class AcceptedHeaderCache {
  private readonly entries = new Map<
    string,
    { ref: ExternalSessionRef; cursor: ExternalCursor; mtimeMs: number }
  >();
  async get(
    root: string,
    file: string,
    workspace?: string
  ): Promise<ExternalSessionRef | null> {
    const cached = this.entries.get(file);
    if (!cached) return null;
    this.entries.delete(file);
    if (
      workspace !== undefined &&
      !validWorkspace(cached.ref.workspacePath, workspace)
    )
      return null;
    // The configured root may itself be a symlink. Every component below it must
    // remain a real directory/file, including when an ancestor was replaced.
    const parts = path.relative(root, file).split(path.sep);
    let current = root;
    let stat;
    for (const part of parts) {
      current = path.join(current, part);
      stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) return null;
    }
    if (
      !stat?.isFile() ||
      stat.ino !== cached.cursor.inode ||
      stat.size < cached.cursor.fileSize ||
      (stat.size === cached.cursor.fileSize &&
        stat.mtimeMs !== cached.mtimeMs) ||
      !(await cursorContentMatches(file, cached.cursor))
    )
      return null;
    cached.cursor = { ...cached.cursor, fileSize: stat.size };
    cached.mtimeMs = stat.mtimeMs;
    cached.ref = { ...cached.ref, updatedAt: stat.mtimeMs };
    this.entries.set(file, cached);
    return { ...cached.ref };
  }
  set(ref: ExternalSessionRef, cursor: ExternalCursor): void {
    // A manually flushed EOF header has no durable bytes to validate yet.
    if (!cursor.byteOffset) return;
    this.entries.delete(ref.filePath);
    this.entries.set(ref.filePath, {
      ref: { ...ref },
      cursor: { ...cursor },
      mtimeMs: ref.updatedAt,
    });
    if (this.entries.size > 512)
      this.entries.delete(this.entries.keys().next().value!);
  }
  cursor(file: string): ExternalCursor | undefined {
    return this.entries.get(file)?.cursor;
  }
  clear(): void {
    this.entries.clear();
  }
}
