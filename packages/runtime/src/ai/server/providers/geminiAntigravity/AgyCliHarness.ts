/**
 * Antigravity CLI (`agy`) headless stream-json harness for `GeminiAntigravityProvider`.
 *
 * Drives the official `agy` CLI (`--input-format stream-json --output-format stream-json`)
 * with one warm child process per Nimbalyst session for fast multi-turn prompt caching,
 * persisted session resume (`--conversation <id>`), live model discovery (`agy models`),
 * text/document attachment inlining, native vision attachments via `--add-dir` + `read_file`,
 * and real per-turn token usage / context-window fill / `/compact` checkpoint reporting.
 */

import { execFile, spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ChatAttachment } from '../../types';
import { syncMcpServersToAgy, type AgyMcpConfigLoader } from './agyMcpSync';

const GEMINI_TEXT_ATTACHMENT_EXT_RE =
  /\.(txt|md|markdown|json|jsonl|yaml|yml|toml|csv|tsv|xml|html|htm|css|scss|less|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|swift|c|cpp|h|hpp|cs|php|sh|bash|zsh|fish|sql|log|ini|cfg|conf|env|dockerfile|makefile|graphql|prisma|svelte|vue)$/i;
const GEMINI_VISUAL_ATTACHMENT_EXT_RE = /\.(png|jpe?g|webp|gif|bmp|tiff?|heic|pdf)$/i;
const GEMINI_MAX_ATTACHMENT_CHARS = 200_000;
const AGY_MODEL_CACHE_TTL_MS = 60_000;

export type AgyPathLoader = () => string | null | undefined;
export type AgyEnvLoader = () =>
  | Record<string, string>
  | null
  | undefined
  | Promise<Record<string, string> | null | undefined>;

export interface AgyDiscoveredModel {
  key: string;
  displayName: string;
}

export interface PreparedAgyAttachments {
  prompt: string;
  extraDirs: string[];
}

export interface AgyTurnUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cache_read_input_tokens?: number;
}

export type AgyTurnEvent =
  | { type: 'text'; content: string }
  | { type: 'tool_call'; id: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; id: string; name: string; args: Record<string, unknown>; result: string }
  | {
      type: 'complete';
      content: string;
      usage?: AgyTurnUsage;
      contextFillTokens?: number;
      contextWindow?: number;
      contextCompacted?: boolean;
    }
  | { type: 'error'; error: string };

export interface AgyTurnOptions {
  sessionId: string;
  prompt: string;
  modelSlug: string;
  workspacePath?: string;
  extraDirs?: string[];
  abortSignal?: AbortSignal;
  pathLoader?: AgyPathLoader | null;
  envLoader?: AgyEnvLoader | null;
  mcpConfigLoader?: AgyMcpConfigLoader | null;
  /** Optional fingerprint (e.g. synced MCP config hash); respawn warm session if it changes. */
  configFingerprint?: string;
  /** Optional resolved binary override (used by caller/tests). */
  agyBinPath?: string;
}

interface CumulativeUsageSnapshot {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
}

interface QueueItem {
  kind: 'event' | 'exit';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: any;
  code?: number | null;
  signal?: NodeJS.Signals | null;
  stderr?: string;
  error?: Error;
}

interface WarmAgySession {
  child: ChildProcess;
  nextItem: () => Promise<QueueItem>;
  convId: string | null;
  modelSlug: string;
  workspacePath: string;
  configFingerprint: string;
  addDirsSet: Set<string>;
  aborted: boolean;
  lastCumulativeUsage: CumulativeUsageSnapshot | null;
}

let cachedAgyModels: AgyDiscoveredModel[] | null = null;
let cachedAgyModelsAt = 0;

/** Reset cached `agy models` discovery (for tests). */
export function __resetAgyModelCacheForTests(): void {
  cachedAgyModels = null;
  cachedAgyModelsAt = 0;
}

export function agyStripAnsi(str: string | null | undefined): string {
  // eslint-disable-next-line no-control-regex
  return String(str ?? '').replace(/\x1b\[[0-9;?]*[a-zA-Z]|\r/g, '');
}

/**
 * Locate the `agy` CLI executable in standard install locations or PATH.
 */
export async function findAgyBinary(pathLoader?: AgyPathLoader | null): Promise<string | null> {
  const exeName = process.platform === 'win32' ? 'agy.exe' : 'agy';
  const candidates: string[] = [
    path.join(os.homedir(), '.local', 'bin', exeName),
    '/opt/homebrew/bin/agy',
    '/usr/local/bin/agy',
  ];

  let envPath = process.env.PATH ?? '';
  try {
    const enhanced = pathLoader?.();
    if (typeof enhanced === 'string' && enhanced.length > 0) {
      envPath = enhanced;
    }
  } catch {
    /* ignore loader failure */
  }

  for (const dir of envPath.split(path.delimiter)) {
    const trimmed = dir.trim().replace(/^"(.*)"$/, '$1');
    if (trimmed) candidates.push(path.join(trimmed, exeName));
  }

  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* not executable */
    }
  }
  return null;
}

/**
 * Build a clean environment for `agy` with login shell env + enhanced PATH,
 * ensuring `ELECTRON_RUN_AS_NODE` is never leaked to child processes.
 */
export async function buildAgyEnv(
  envLoader?: AgyEnvLoader | null,
  pathLoader?: AgyPathLoader | null,
): Promise<NodeJS.ProcessEnv> {
  let shellEnv: Record<string, string> = {};
  try {
    const loaded = envLoader ? await envLoader() : null;
    if (loaded && typeof loaded === 'object') shellEnv = loaded;
  } catch {
    /* ignore env loader failure */
  }

  let enhancedPath = process.env.PATH ?? '';
  try {
    const loadedPath = pathLoader?.();
    if (typeof loadedPath === 'string' && loadedPath.length > 0) {
      enhancedPath = loadedPath;
    }
  } catch {
    /* ignore path loader failure */
  }

  const localBin = path.join(os.homedir(), '.local', 'bin');
  if (!enhancedPath.split(path.delimiter).includes(localBin)) {
    enhancedPath = enhancedPath ? `${localBin}${path.delimiter}${enhancedPath}` : localBin;
  }

  const env: NodeJS.ProcessEnv = { ...shellEnv, ...process.env, PATH: enhancedPath };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

/**
 * Parse stdout from `agy models` (supports both tab-separated and multi-space columns).
 */
export function parseAgyModelsOutput(stdout: string): AgyDiscoveredModel[] {
  const models: AgyDiscoveredModel[] = [];
  const seen = new Set<string>();
  for (const rawLine of agyStripAnsi(stdout).split('\n')) {
    const line = rawLine.trim();
    if (!line || /Fetching available models/i.test(line)) continue;
    const match = /^([a-z0-9][a-z0-9._-]*)(?:\t+|\s{2,})(.+)$/.exec(line);
    if (!match) continue;
    const key = match[1].trim();
    const displayName = match[2].trim();
    if (!key || !displayName || seen.has(key)) continue;
    seen.add(key);
    models.push({ key, displayName });
  }
  return models;
}

/**
 * Discover available models live via `agy models`, cached for 60s.
 * Returns null if `agy` is not installed or fails without a cached fallback.
 */
export async function discoverAgyModels(
  pathLoader?: AgyPathLoader | null,
  envLoader?: AgyEnvLoader | null,
  deps?: {
    findBinary?: (loader?: AgyPathLoader | null) => Promise<string | null>;
    execFileFn?: typeof execFile;
  },
): Promise<AgyDiscoveredModel[] | null> {
  if (cachedAgyModels && Date.now() - cachedAgyModelsAt < AGY_MODEL_CACHE_TTL_MS) {
    return cachedAgyModels;
  }
  const agyBin = await (deps?.findBinary ?? findAgyBinary)(pathLoader);
  if (!agyBin) return null;

  const env = await buildAgyEnv(envLoader, pathLoader);
  const runExecFile = deps?.execFileFn ?? execFile;

  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      runExecFile(agyBin, ['models'], { env, timeout: 15_000, encoding: 'utf8' }, (err, out) => {
        if (err) reject(err);
        else resolve(String(out ?? ''));
      });
    });
    const models = parseAgyModelsOutput(stdout);
    if (models.length > 0) {
      cachedAgyModels = models;
      cachedAgyModelsAt = Date.now();
      return models;
    }
  } catch (err) {
    console.warn('[AgyCliHarness] Failed to list models via `agy models`:', err instanceof Error ? err.message : err);
  }
  return cachedAgyModels;
}

/**
 * Prepare chat attachments for `agy`:
 * - Text/code/document attachments (e.g. `pasted-text-*.txt`) are inlined directly into the prompt.
 * - Image/screenshot/PDF attachments expose their parent directory via `extraDirs` (`--add-dir`)
 *   and instruct `agy` to call `read_file` on the absolute path for native vision inspection.
 */
export async function prepareAgyAttachments(
  text: string,
  attachments?: ChatAttachment[] | null,
): Promise<PreparedAgyAttachments> {
  const baseText = typeof text === 'string' ? text : '';
  const extraDirs = new Set<string>();
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return { prompt: baseText, extraDirs: [] };
  }

  const blocks: string[] = [];

  for (const att of attachments) {
    if (!att || typeof att !== 'object') continue;
    const filepath = typeof att.filepath === 'string' ? att.filepath : '';
    if (filepath) {
      extraDirs.add(path.dirname(filepath));
    }
    const label = att.filename || (filepath ? path.basename(filepath) : 'attachment');
    const mime = typeof att.mimeType === 'string' ? att.mimeType.toLowerCase() : '';

    const isVisual =
      att.type === 'image' ||
      att.type === 'pdf' ||
      mime.startsWith('image/') ||
      mime === 'application/pdf' ||
      GEMINI_VISUAL_ATTACHMENT_EXT_RE.test(label);

    if (isVisual && filepath) {
      const kind = att.type === 'pdf' || mime === 'application/pdf' ? 'PDF' : 'image/screenshot';
      blocks.push(
        `[Attached ${kind}: "${label}" at absolute path: ${filepath} — Call read_file on "${filepath}" immediately to visually inspect this attachment before answering.]`,
      );
      continue;
    }

    const isTextLike =
      att.type === 'document' ||
      (att.type as string) === 'text' ||
      mime.startsWith('text/') ||
      mime === 'application/json' ||
      mime === 'application/xml' ||
      mime === 'application/javascript' ||
      GEMINI_TEXT_ATTACHMENT_EXT_RE.test(label);

    if (isTextLike && filepath) {
      try {
        let content = await fs.promises.readFile(filepath, 'utf8');
        if (content.length > GEMINI_MAX_ATTACHMENT_CHARS) {
          content =
            content.slice(0, GEMINI_MAX_ATTACHMENT_CHARS) +
            `\n[attachment truncated at ${GEMINI_MAX_ATTACHMENT_CHARS} characters]`;
        }
        blocks.push(`[Attached file: ${label}]\n${content}\n[/Attached file]`);
        continue;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        blocks.push(`[Attached file: ${label} (path: ${filepath}) -- read failed: ${msg}]`);
        continue;
      }
    }

    const inlineContent = (att as { content?: unknown }).content;
    if (typeof inlineContent === 'string' && inlineContent.length > 0) {
      const content =
        inlineContent.length > GEMINI_MAX_ATTACHMENT_CHARS
          ? inlineContent.slice(0, GEMINI_MAX_ATTACHMENT_CHARS) +
            `\n[attachment truncated at ${GEMINI_MAX_ATTACHMENT_CHARS} characters]`
          : inlineContent;
      blocks.push(`[Attached file: ${label}]\n${content}\n[/Attached file]`);
      continue;
    }

    blocks.push(`[Attached ${att.type || 'file'}: ${label}${filepath ? ` (path: ${filepath})` : ''}]`);
  }

  const prompt = blocks.length > 0 ? blocks.join('\n\n') + (baseText ? `\n\n${baseText}` : '') : baseText;
  return { prompt, extraDirs: [...extraDirs] };
}

/** Inline text attachments into a flat prompt (used by the fallback tool loop). */
export async function inlineGeminiAttachments(
  text: string,
  attachments?: ChatAttachment[] | null,
): Promise<string> {
  const res = await prepareAgyAttachments(text, attachments);
  return res.prompt;
}

/** Normalize a namespaced or legacy display-name Gemini model ID into an `agy` slug. */
export function normalizeAgyModelSlug(rawModel?: string | null): string {
  if (!rawModel) return 'gemini-4-neon-high';
  const bare = rawModel.includes(':') ? rawModel.split(':').slice(1).join(':') : rawModel;
  const lower = bare.toLowerCase().trim();
  const displayNameMap: Record<string, string> = {
    'gemini 4 neon (xhigh)': 'gemini-4-neon-xhigh',
    'gemini 4 neon (high)': 'gemini-4-neon-high',
    'gemini 4 neon (medium)': 'gemini-4-neon-medium',
    'gemini 4 neon (low)': 'gemini-4-neon-low',
  };
  return displayNameMap[lower] ?? bare;
}

/** Known context-window sizes (tokens) for models exposed via `agy models`. */
export function contextWindowForAgyModel(modelSlug?: string | null): number {
  const slug = String(modelSlug ?? '').toLowerCase();
  if (slug.startsWith('claude-')) return 200_000;
  if (slug.startsWith('gpt-oss')) return 131_072;
  return 1_048_576;
}

export interface AgySessionManagerDeps {
  spawnFn?: typeof spawn;
  findBinary?: (pathLoader?: AgyPathLoader | null) => Promise<string | null>;
  convMapPath?: string;
  userDataDir?: string;
}

/**
 * Manages warm `agy` stream-json subprocesses keyed by Nimbalyst session ID.
 */
export class AgySessionManager {
  private static instance: AgySessionManager | null = null;

  static shared(): AgySessionManager {
    if (!this.instance) this.instance = new AgySessionManager();
    return this.instance;
  }

  private readonly sessions = new Map<string, WarmAgySession>();
  private convMap: Record<string, string> | null = null;
  private exitHookInstalled = false;
  private readonly spawnFn: typeof spawn;
  private readonly findBinaryFn: (pathLoader?: AgyPathLoader | null) => Promise<string | null>;
  private readonly convMapPath: string;
  private readonly userDataDir: string;

  constructor(deps?: AgySessionManagerDeps) {
    this.spawnFn = deps?.spawnFn ?? spawn;
    this.findBinaryFn = deps?.findBinary ?? findAgyBinary;
    this.convMapPath =
      deps?.convMapPath ??
      path.join(os.homedir(), '.gemini', 'antigravity', 'nimbalyst_session_map.json');
    this.userDataDir =
      deps?.userDataDir ??
      (process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support', '@nimbalyst', 'electron')
        : process.platform === 'win32'
          ? path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), '@nimbalyst', 'electron')
          : path.join(os.homedir(), '.config', '@nimbalyst', 'electron'));
  }

  private installExitHook(): void {
    if (this.exitHookInstalled) return;
    this.exitHookInstalled = true;
    const cleanup = () => this.closeAll();
    process.once('beforeExit', cleanup);
    process.once('exit', cleanup);
  }

  private async loadConvMap(): Promise<Record<string, string>> {
    if (this.convMap) return this.convMap;
    this.convMap = {};
    try {
      const raw = await fs.promises.readFile(this.convMapPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        this.convMap = parsed as Record<string, string>;
      }
    } catch {
      /* first run or unreadable map */
    }
    return this.convMap;
  }

  private async saveConvId(sessionId: string, convId: string): Promise<void> {
    if (!sessionId || !convId) return;
    const map = await this.loadConvMap();
    if (map[sessionId] === convId) return;
    map[sessionId] = convId;
    try {
      await fs.promises.mkdir(path.dirname(this.convMapPath), { recursive: true });
      const tmp = `${this.convMapPath}.tmp.${process.pid}`;
      await fs.promises.writeFile(tmp, JSON.stringify(map, null, 2), 'utf8');
      await fs.promises.rename(tmp, this.convMapPath);
    } catch {
      /* best effort */
    }
  }

  closeSession(sessionId: string): void {
    const st = this.sessions.get(sessionId);
    if (!st) return;
    this.sessions.delete(sessionId);
    if (st.child && !st.child.killed) {
      try {
        st.child.kill('SIGINT');
        const timer = setTimeout(() => {
          if (st.child && !st.child.killed && st.child.exitCode === null) {
            try {
              st.child.kill('SIGKILL');
            } catch {
              /* ignore */
            }
          }
        }, 1_500);
        timer.unref?.();
      } catch {
        /* ignore */
      }
    }
  }

  abortSession(sessionId: string): void {
    const st = this.sessions.get(sessionId);
    if (!st) return;
    st.aborted = true;
    this.closeSession(sessionId);
  }

  closeAll(): void {
    for (const sid of [...this.sessions.keys()]) {
      this.closeSession(sid);
    }
  }

  async *runTurn(options: AgyTurnOptions): AsyncIterableIterator<AgyTurnEvent> {
    const {
      sessionId,
      prompt,
      modelSlug,
      workspacePath,
      extraDirs,
      abortSignal,
      pathLoader,
      envLoader,
      mcpConfigLoader,
      configFingerprint: explicitFingerprint,
      agyBinPath,
    } = options;

    this.installExitHook();
    const agyBin = agyBinPath ?? (await this.findBinaryFn(pathLoader));
    if (!agyBin) {
      throw new Error('Antigravity CLI (agy) not found.');
    }

    const syncedFingerprint = mcpConfigLoader
      ? await syncMcpServersToAgy(workspacePath, sessionId, mcpConfigLoader)
      : '';
    const configFingerprint = explicitFingerprint ?? syncedFingerprint;

    const convMap = await this.loadConvMap();
    const existingConvId = convMap[sessionId] ?? null;

    // Grant read access to Nimbalyst userData, temp dirs, and attachment parent dirs for native vision.
    const addDirs = new Set<string>();
    if (fs.existsSync(this.userDataDir)) addDirs.add(this.userDataDir);
    if (fs.existsSync('/tmp')) addDirs.add('/tmp');
    const osTmp = os.tmpdir();
    if (osTmp && fs.existsSync(osTmp)) addDirs.add(osTmp);
    for (const dir of extraDirs ?? []) {
      if (dir && fs.existsSync(dir)) addDirs.add(dir);
    }
    const sortedAddDirs = [...addDirs].sort();

    let st = this.sessions.get(sessionId);
    const needRespawn =
      !st ||
      !st.child ||
      st.child.killed ||
      st.child.exitCode !== null ||
      st.modelSlug !== modelSlug ||
      st.workspacePath !== (workspacePath ?? '') ||
      (configFingerprint !== '' && st.configFingerprint !== configFingerprint) ||
      !sortedAddDirs.every((d) => st!.addDirsSet.has(d));

    if (!st || needRespawn) {
      const resumeId = st?.convId ?? existingConvId;
      if (st) this.closeSession(sessionId);

      const args = [
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--dangerously-skip-permissions',
        '--model',
        modelSlug,
      ];
      if (resumeId) {
        args.push('--conversation', resumeId);
      }
      for (const dir of sortedAddDirs) {
        args.push('--add-dir', dir);
      }

      const env = await buildAgyEnv(envLoader, pathLoader);
      const cwd = workspacePath && fs.existsSync(workspacePath) ? workspacePath : os.homedir();
      const child = this.spawnFn(agyBin, args, {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });

      const queue: QueueItem[] = [];
      let notify: (() => void) | null = null;
      let stdoutBuf = '';
      let stderrTail = '';
      let exited = false;
      let exitInfo: Omit<QueueItem, 'kind'> | null = null;

      const push = (item: QueueItem): void => {
        queue.push(item);
        if (notify) {
          const fn = notify;
          notify = null;
          fn();
        }
      };

      child.stdout?.on('data', (chunk: Buffer) => {
        stdoutBuf += chunk.toString('utf8');
        let idx: number;
        while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
          const line = stdoutBuf.slice(0, idx).trim();
          stdoutBuf = stdoutBuf.slice(idx + 1);
          if (!line) continue;
          try {
            push({ kind: 'event', data: JSON.parse(line) });
          } catch {
            /* ignore non-JSON progress lines */
          }
        }
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString('utf8')).slice(-3_000);
      });

      child.on('error', (err) => {
        exited = true;
        exitInfo = { error: err };
        push({ kind: 'exit', error: err });
      });

      child.on('exit', (code, signal) => {
        exited = true;
        exitInfo = { code, signal, stderr: stderrTail };
        push({ kind: 'exit', code, signal, stderr: stderrTail });
      });

      const nextItem = async (): Promise<QueueItem> => {
        if (queue.length > 0) return queue.shift()!;
        if (exited) return { kind: 'exit', ...(exitInfo ?? {}) };
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
        return queue.length > 0 ? queue.shift()! : { kind: 'exit', ...(exitInfo ?? {}) };
      };

      st = {
        child,
        nextItem,
        convId: resumeId,
        modelSlug,
        workspacePath: workspacePath ?? '',
        configFingerprint,
        addDirsSet: new Set(sortedAddDirs),
        aborted: false,
        lastCumulativeUsage: null,
      };
      this.sessions.set(sessionId, st);
    }

    const onAbort = (): void => {
      this.abortSession(sessionId);
    };
    if (abortSignal) {
      if (abortSignal.aborted) {
        this.abortSession(sessionId);
        return;
      }
      abortSignal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      const payload = JSON.stringify({ event: 'user', message: { content: prompt } }) + '\n';
      st.child.stdin?.write(payload);

      let streamedText = '';
      let sawCheckpoint = false;
      let lastStepContextFill: number | undefined;
      const activeTools = new Map<number, { id: string; name: string; args: Record<string, unknown> }>();
      const contextWindow = contextWindowForAgyModel(modelSlug);

      while (true) {
        if (abortSignal?.aborted || st.aborted) return;
        const item = await st.nextItem();
        if (abortSignal?.aborted || st.aborted) return;

        if (item.kind === 'exit') {
          this.sessions.delete(sessionId);
          if (item.error) throw item.error;
          const detail = item.stderr ? agyStripAnsi(item.stderr).trim().slice(-600) : '';
          throw new Error(
            `Antigravity CLI exited unexpectedly (code=${item.code}, signal=${item.signal})${detail ? `: ${detail}` : ''}`,
          );
        }

        const ev = item.data;
        if (!ev || typeof ev !== 'object') continue;

        if (ev.event === 'init') {
          const cid = ev.conversation_id ?? ev.init?.conversation_id;
          if (typeof cid === 'string' && cid) {
            st.convId = cid;
            void this.saveConvId(sessionId, cid);
          }
          continue;
        }

        if (ev.event === 'step_update' && ev.step_update) {
          const u = ev.step_update;
          if (typeof u.conversation_id === 'string' && u.conversation_id && u.conversation_id !== st.convId) {
            st.convId = u.conversation_id;
            void this.saveConvId(sessionId, u.conversation_id);
          }

          if (u.step_type === 'checkpoint') {
            sawCheckpoint = true;
          } else if (u.step_type === 'agent_response') {
            if (typeof u.text_delta === 'string' && u.text_delta.length > 0) {
              streamedText += u.text_delta;
              yield { type: 'text', content: u.text_delta };
            }
            if (u.state === 'DONE' && u.usage && typeof u.usage === 'object') {
              const stepIn = Number(u.usage.input_tokens) || 0;
              const stepCacheRead = Number(u.usage.cache_read_tokens) || 0;
              const stepOut = Number(u.usage.output_tokens) || 0;
              const fill = stepIn + stepCacheRead + stepOut;
              if (fill > 0) lastStepContextFill = fill;
            }
          } else if (u.step_type === 'tool') {
            const stepIdx = typeof u.step_index === 'number' ? u.step_index : 0;
            const toolName = String(u.tool_info?.name ?? u.tool_name ?? 'tool');
            const toolArgs: Record<string, unknown> =
              u.tool_info?.parameters && typeof u.tool_info.parameters === 'object'
                ? u.tool_info.parameters
                : {};

            if (u.state === 'ACTIVE') {
              const id = `agy-${Date.now()}-${stepIdx}`;
              activeTools.set(stepIdx, { id, name: toolName, args: toolArgs });
              yield { type: 'tool_call', id, name: toolName, args: toolArgs };
            } else if (u.state === 'DONE') {
              let rec = activeTools.get(stepIdx);
              if (!rec) {
                rec = { id: `agy-${Date.now()}-${stepIdx}`, name: toolName, args: toolArgs };
                yield { type: 'tool_call', id: rec.id, name: rec.name, args: rec.args };
              }
              let resultText = '';
              if (u.tool_info?.error) {
                resultText = `Error: ${u.tool_info.error.message ?? JSON.stringify(u.tool_info.error)}`;
              } else if (typeof u.tool_info?.output === 'string') {
                resultText = u.tool_info.output;
              } else if (u.tool_info?.output !== undefined) {
                try {
                  resultText = JSON.stringify(u.tool_info.output);
                } catch {
                  resultText = String(u.tool_info.output);
                }
              } else {
                resultText = '(completed)';
              }
              activeTools.delete(stepIdx);
              yield {
                type: 'tool_result',
                id: rec.id,
                name: rec.name,
                args: rec.args,
                result: resultText,
              };
            }
          }
          continue;
        }

        if (ev.event === 'result' && ev.result) {
          const r = ev.result;
          if (typeof r.conversation_id === 'string' && r.conversation_id) {
            st.convId = r.conversation_id;
            void this.saveConvId(sessionId, r.conversation_id);
          }

          if (r.status === 'SUCCESS') {
            let turnUsage: AgyTurnUsage | undefined;
            if (r.usage && typeof r.usage === 'object') {
              const cumIn = Number(r.usage.input_tokens) || 0;
              const cumOut = Number(r.usage.output_tokens) || 0;
              const cumCacheRead = Number(r.usage.cache_read_tokens) || 0;
              const prev = st.lastCumulativeUsage;
              const reset =
                !prev ||
                cumIn < prev.input_tokens ||
                cumOut < prev.output_tokens ||
                cumCacheRead < prev.cache_read_tokens;
              const deltaIn = reset ? cumIn : cumIn - prev.input_tokens;
              const deltaOut = reset ? cumOut : cumOut - prev.output_tokens;
              const deltaCacheRead = reset ? cumCacheRead : cumCacheRead - prev.cache_read_tokens;
              st.lastCumulativeUsage = {
                input_tokens: cumIn,
                output_tokens: cumOut,
                cache_read_tokens: cumCacheRead,
              };
              turnUsage = {
                input_tokens: deltaIn,
                output_tokens: deltaOut,
                total_tokens: deltaIn + deltaOut,
                ...(deltaCacheRead > 0 ? { cache_read_input_tokens: deltaCacheRead } : {}),
              };
              if (lastStepContextFill === undefined && !sawCheckpoint) {
                const fallbackFill = deltaIn + deltaCacheRead + deltaOut;
                if (fallbackFill > 0) lastStepContextFill = fallbackFill;
              }
            }

            const finalResponse =
              typeof r.response === 'string' && r.response.length > 0
                ? r.response
                : streamedText || (sawCheckpoint ? 'Conversation compacted.' : '');
            if (!streamedText && finalResponse) {
              yield { type: 'text', content: finalResponse };
            }
            yield {
              type: 'complete',
              content: finalResponse || '(no model response)',
              ...(turnUsage ? { usage: turnUsage } : {}),
              ...(sawCheckpoint
                ? { contextCompacted: true }
                : lastStepContextFill !== undefined
                  ? { contextFillTokens: lastStepContextFill, contextWindow }
                  : {}),
            };
            return;
          }

          const errMsg = r.error || `Antigravity CLI finished with status: ${r.status}`;
          yield { type: 'error', error: String(errMsg) };
          return;
        }
      }
    } finally {
      if (abortSignal) {
        abortSignal.removeEventListener('abort', onAbort);
      }
    }
  }
}
