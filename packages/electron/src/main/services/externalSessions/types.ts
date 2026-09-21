/** A reference is one physical file; sidecars share their parent's externalId. */
export type ExternalProviderId = "claude-code" | "openai-codex";

export interface ExternalSessionRef {
  providerId: ExternalProviderId;
  externalId: string;
  /** Absolute cwd verified from the log, never decoded from a directory name. */
  workspacePath: string;
  filePath: string;
  createdAt?: number;
  updatedAt: number;
  title?: string;
  titleKind?: "fallback" | "generated" | "explicit";
  model?: string;
  parentToolUseId?: string;
  /** A fork's header identifies the copied parent metadata immediately after it. */
  codexInheritedMeta?: { id: string; byteOffset: number };
}

export interface ExternalCursor {
  byteOffset: number;
  lastEntryUuid: string | null;
  fileSize: number;
  inode: number | null;
  /** Unfinished wrappers emitted by manual/idle/cap fallback; sorted unique IDs, absent when empty. */
  codexFallbackCalls?: string[];
  /** SHA256 of bounded committed prefix/boundary samples; absent on legacy cursors. */
  contentMarker?: string;
}

export interface ExternalRawMessage {
  /** Stable across retries, truncation and inode replacement; persistence dedupes this. */
  sourceEntryId: string;
  direction: "input" | "output";
  content: string;
  metadata: Record<string, unknown> | null;
  timestamp: string;
}

export interface ExternalReadResult {
  messages: ExternalRawMessage[];
  cursor: ExternalCursor;
  /** Complete data remains; false for an incomplete tail (wait for a change). */
  hasMore: boolean;
  reset: boolean;
  title?: string;
  titleKind?: "fallback" | "generated" | "explicit";
  model?: string;
}

export interface ExternalReadOptions {
  /** Manual backfill only: emit a valid, stable EOF record without committing past the last newline. */
  includeFinalLine?: boolean;
}

export interface ExternalDiscoveryPage {
  sessions: ExternalSessionRef[];
  /** More bounded traversal remains, even if this page contains no matching sessions. */
  hasMore: boolean;
}

export interface ExternalSessionSource {
  readonly providerId: ExternalProviderId;
  /** Includes ancestors needed to observe date rollover / late sidecar creation. */
  watchRoots(workspaces: string[]): string[];
  /** Bounded discovery page. Repeated calls cycle through candidates; scope is required. */
  discover(workspacePath: string): Promise<ExternalSessionRef[]>;
  /** Resolve a watcher event directly. Null incomplete headers remain retryable; only validated foreign cwd is cached. */
  identify(
    filePath: string,
    workspacePaths: string[]
  ): Promise<ExternalSessionRef | null>;
  /** Explicit manual backfill, including historical dates and (when omitted) all logged workspaces. */
  discoverPage(workspacePath?: string): Promise<ExternalDiscoveryPage>;
  readSince(
    ref: ExternalSessionRef,
    cursor: ExternalCursor | null,
    options?: ExternalReadOptions
  ): Promise<ExternalReadResult>;
  /** Releases any directory iterators used by bounded discovery. */
  dispose(): Promise<void>;
}

export interface ExternalSourceOptions {
  /** Provider log root (Claude projects directory or Codex sessions directory). */
  rootDir?: string;
  maxReadBytes?: number;
  maxLineBytes?: number;
  maxDiscoveryEntries?: number;
  now?: () => Date;
}
