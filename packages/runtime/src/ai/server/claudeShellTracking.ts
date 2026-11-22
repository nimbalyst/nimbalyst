/**
 * Claude Code Bash windows for shell file attribution.
 *
 * Claude's PreToolUse/PostToolUse hooks run in-process, so they bracket every
 * Bash call (including subagent Bash, which reports through the parent's hooks)
 * without the loopback endpoint Codex needs. Electron supplies the sink that
 * drives `ShellFileAttribution`; runtime never imports Electron services.
 *
 * A file changed inside a session's Bash window is linked to that session
 * whether or not the command names it. When two sessions' windows overlap the
 * tracker abstains and records a coverage reason instead of guessing.
 */

export interface ClaudeShellTrackingSink {
  /** Opens a window before the command runs. Resolves once the baseline is captured. */
  pre(sessionId: string, toolUseId: string): Promise<void>;
  /** Closes a window. Unknown ids are ignored. */
  post(sessionId: string, toolUseId: string): Promise<void>;
  /** Closes every window of the session's turn, including backgrounded commands, synchronously; settles once they have persisted. */
  endTurn(sessionId: string): Promise<void>;
  /** Waits (bounded) for closing windows to persist their links. */
  drain(sessionId: string): Promise<void>;
  /** Whether the session is registered with the tracker. */
  isTracking(sessionId: string): boolean;
}

let sink: ClaudeShellTrackingSink | undefined;
/** Commands started with `run_in_background`; their window stays open until turn end. */
const background = new Map<string, Set<string>>();
/** Posts still closing, so the turn-end drain waits for windows it has not seen yet. */
const closing = new Map<string, Set<Promise<void>>>();
/** Files the tracker linked to each session this turn, for turn-end history snapshots. */
const attributed = new Map<string, Set<string>>();

/**
 * A pre hook must never hold a command indefinitely. The tracker's own budgets
 * (event drain plus baseline capture) are about 2.75 s; past this the command
 * runs and its window abstains on its own.
 */
const PRE_HOOK_CAP_MS = 3_000;

export function setClaudeShellTrackingSink(value: ClaudeShellTrackingSink | undefined): void {
  sink = value;
}

export function isClaudeShellTrackingActive(sessionId: string | undefined): boolean {
  return !!sink && !!sessionId && sink.isTracking(sessionId);
}

export async function claudeShellPre(sessionId: string | undefined, toolUseId: string | undefined, input: unknown): Promise<void> {
  if (!sink || !sessionId || !toolUseId || !sink.isTracking(sessionId)) return;
  const args = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  if (args.run_in_background === true) {
    let ids = background.get(sessionId);
    if (!ids) background.set(sessionId, ids = new Set());
    ids.add(toolUseId);
  }
  await capped(sink.pre(sessionId, toolUseId).catch(() => {}));
}

/** Waits for `work` at most PRE_HOOK_CAP_MS; the work itself keeps running. */
async function capped(work: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([work, new Promise<void>((resolve) => { timer = setTimeout(resolve, PRE_HOOK_CAP_MS); })]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Called from PostToolUse and from `tool_result` (denied or interrupted calls
 * skip PostToolUse). `failed` marks an error result: a backgrounded command
 * that was denied or failed to start is over, unlike one that was acknowledged.
 */
export function claudeShellPost(sessionId: string | undefined, toolUseId: string | undefined, options: { failed?: boolean } = {}): void {
  if (!sink || !sessionId || !toolUseId) return;
  // A backgrounded command's acknowledgement is not its end.
  const backgrounded = background.get(sessionId);
  if (backgrounded?.has(toolUseId)) {
    if (!options.failed) return;
    backgrounded.delete(toolUseId);
  }
  let pending = closing.get(sessionId);
  if (!pending) closing.set(sessionId, pending = new Set());
  const post = sink.post(sessionId, toolUseId).catch(() => {});
  pending.add(post);
  void post.finally(() => {
    pending!.delete(post);
    if (pending!.size === 0 && closing.get(sessionId) === pending) closing.delete(sessionId);
  });
}

/** Closes the turn's windows now; the promise settles once their links have persisted. */
export function claudeShellEndTurn(sessionId: string | undefined): Promise<void> {
  if (!sessionId) return Promise.resolve();
  background.delete(sessionId);
  return sink ? sink.endTurn(sessionId).catch(() => {}) : Promise.resolve();
}

/** Bounded wait for closing windows, then the files linked since the last call. */
export async function takeClaudeShellAttributedFiles(sessionId: string | undefined): Promise<string[]> {
  if (!sessionId) return [];
  const posts = [...(closing.get(sessionId) ?? [])];
  if (posts.length) await capped(Promise.all(posts).then(() => {}));
  if (sink?.isTracking(sessionId)) await capped(sink.drain(sessionId).catch(() => {}));
  const files = attributed.get(sessionId);
  attributed.delete(sessionId);
  return files ? [...files] : [];
}

/** Electron reports each persisted shell link here. */
export function recordClaudeShellAttributedFile(sessionId: string, filePath: string): void {
  let files = attributed.get(sessionId);
  if (!files) attributed.set(sessionId, files = new Set());
  if (files.size < 2048) files.add(filePath);
}

export function __resetClaudeShellTrackingForTests(): void {
  sink = undefined;
  background.clear();
  attributed.clear();
  closing.clear();
}
