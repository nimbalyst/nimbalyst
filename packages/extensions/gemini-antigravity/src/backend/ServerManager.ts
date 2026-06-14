/**
 * AntigravityServerManager (backend module).
 *
 * Direct adaptation of packages/runtime/src/ai/server/providers/antigravity/
 * AntigravityServerManager.ts. The difference: this version is owned by the
 * extension's backend module (not the runtime), and it accepts injected
 * configuration from the host (OVERRIDE_IDE_VERSION, SPAWN_PORT_CANDIDATES)
 * via configure() rather than reading hardcoded constants. This lets the host
 * push fresh values from manifest/user settings without requiring an
 * extension rebuild when Antigravity bumps its supported-build floor.
 *
 * Two modes (auto-selected by ensureRunning):
 *   A. Attach to a running Antigravity "hub" language server (IDE open).
 *   B. Spawn and manage our own standalone hub server.
 *
 * Auth is the user's existing ~/.gemini OAuth credential; the server refreshes
 * it itself. nimbalyst stores no API key and triggers no browser flow (per the
 * project's no-env-key rule).
 *
 * Singleton-per-process: use AntigravityServerManager.shared(). The backend
 * module's activate() calls .configure() on the shared instance once at
 * activation time.
 */
import { spawn, ChildProcess, execFile } from 'child_process';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { randomUUID } from 'crypto';
import { acquireSpawnLock, releaseSpawnLock } from './spawnLock';

const SERVICE = 'exa.language_server_pb.LanguageServerService';

// Fallback defaults if the host doesn't supply config (e.g. dev harness, tests).
// Keep these in sync with the canonical runtime values. The host SHOULD always
// inject a value via configure(), so divergence here is not load-bearing.
const DEFAULT_OVERRIDE_IDE_VERSION = '2.1.4';
const DEFAULT_SPAWN_PORT_CANDIDATES: readonly number[] = [
  51717, 8765, 13456, 21345, 31987, 41234,
];

export interface AntigravityEndpoint {
  httpsPort: number;
  csrf: string;
  /** true when we spawned this server ourselves (mode B); false when attached (mode A). */
  owned: boolean;
}

export interface AntigravityModelInfo {
  /** Stable key, e.g. "gemini-3-flash-agent". */
  key: string;
  /** Server-assigned enum, e.g. "MODEL_PLACEHOLDER_M133". NOT stable across builds. */
  enum: string;
  /** Human label, e.g. "Gemini 3.5 Flash (High)". */
  displayName: string;
  apiProvider?: string;
  maxTokens?: number;
}

export interface AntigravityServerConfig {
  overrideIdeVersion?: string;
  spawnPortCandidates?: readonly number[];
}

export class AntigravityVersionGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AntigravityVersionGateError';
  }
}

export class AntigravityServerManager {
  private static instance: AntigravityServerManager | null = null;

  // Cross-process lock so sibling backend module processes (one per workspace/
  // worktree) share ONE language server instead of each spawning their own and
  // contending on --app_data_dir + the ~/.gemini OAuth (which hangs
  // GetModelResponse). See spawnLock.ts.
  private static readonly SPAWN_LOCK_PATH =
    path.join(os.tmpdir(), 'nimbalyst-antigravity-spawn.lock');
  // How long a waiting process polls for a sibling's server before giving up.
  private static readonly SPAWN_WAIT_MS = 75_000;

  private endpoint: AntigravityEndpoint | null = null;
  private child: ChildProcess | null = null;
  private startPromise: Promise<AntigravityEndpoint> | null = null;
  /** Cache of key -> enum, valid for the current endpoint only. */
  private enumCache = new Map<string, string>();

  // Injected configuration. Falls back to the hardcoded defaults when the
  // host hasn't called configure() (dev harness, unit tests).
  private overrideIdeVersion: string = DEFAULT_OVERRIDE_IDE_VERSION;
  private spawnPortCandidates: readonly number[] = DEFAULT_SPAWN_PORT_CANDIDATES;

  static shared(): AntigravityServerManager {
    if (!this.instance) this.instance = new AntigravityServerManager();
    return this.instance;
  }

  /**
   * Apply host-provided configuration. Idempotent. Safe to call before or
   * after the first ensureRunning(); applies to subsequent spawns/RPC error
   * messages. Existing running server is NOT restarted automatically -- the
   * caller can call stop() first if they want a clean cycle on a version
   * bump.
   */
  configure(cfg: AntigravityServerConfig): void {
    if (typeof cfg.overrideIdeVersion === 'string' && cfg.overrideIdeVersion.length > 0) {
      this.overrideIdeVersion = cfg.overrideIdeVersion;
    }
    if (Array.isArray(cfg.spawnPortCandidates) && cfg.spawnPortCandidates.length > 0) {
      // Defensive copy so the caller can't mutate our array after handoff.
      this.spawnPortCandidates = [...cfg.spawnPortCandidates];
    }
  }

  /** Resolve the language_server.exe path for the current platform. */
  static binaryPath(): string {
    if (process.platform === 'win32') {
      const local = process.env.LOCALAPPDATA
        || path.join(os.homedir(), 'AppData', 'Local');
      return path.join(local, 'Programs', 'Antigravity', 'resources', 'bin',
        'language_server.exe');
    }
    if (process.platform === 'darwin') {
      return '/Applications/Antigravity.app/Contents/Resources/bin/language_server';
    }
    return path.join(os.homedir(), '.local', 'share', 'antigravity', 'bin',
      'language_server');
  }

  /** True if the Antigravity install (the language server binary) is present. */
  static isInstalled(): boolean {
    try {
      return fs.existsSync(this.binaryPath());
    } catch {
      return false;
    }
  }

  /** True if ~/.gemini has an OAuth credential with a refresh token. */
  static hasGeminiAuth(): boolean {
    try {
      const p = path.join(os.homedir(), '.gemini', 'oauth_creds.json');
      if (!fs.existsSync(p)) return false;
      const creds = JSON.parse(fs.readFileSync(p, 'utf8'));
      return Boolean(creds && creds.refresh_token);
    } catch {
      return false;
    }
  }

  /**
   * Ensure a usable server endpoint exists. Attaches to a running hub if
   * present, otherwise spawns our own. Idempotent and concurrency-safe.
   */
  async ensureRunning(): Promise<AntigravityEndpoint> {
    if (this.endpoint && (await this.isHealthy(this.endpoint))) {
      return this.endpoint;
    }
    if (this.startPromise) return this.startPromise;

    this.startPromise = (async () => {
      this.endpoint = null;
      this.enumCache.clear();

      const attached = await this.discoverRunningHub();
      if (attached) {
        this.endpoint = attached;
        return attached;
      }

      const spawned = await this.spawnStandaloneSerialized();
      this.endpoint = spawned;
      return spawned;
    })();

    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  /**
   * Return the live endpoint if the server is already running, else null.
   *
   * Read-only: this MUST NOT spawn the server or trigger discovery. It only
   * reflects whatever endpoint ensureRunning() previously established. Used by
   * the host's usage poller so opening the usage chip never fires up the
   * language server.
   */
  currentEndpoint(): AntigravityEndpoint | null {
    return this.endpoint;
  }

  /** Stop the server if we own it. No-op when attached to the IDE's hub. */
  stop(): void {
    if (this.child && !this.child.killed) {
      try {
        this.child.kill();
      } catch {
        /* best effort */
      }
    }
    this.child = null;
    this.endpoint = null;
    this.enumCache.clear();
  }

  // ---- RPC ---------------------------------------------------------------

  /** Low-level Connect-RPC POST returning parsed JSON. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private rpc<T = any>(method: string, body: unknown, ep: AntigravityEndpoint,
    timeoutMs = 120_000): Promise<T> {
    const payload = Buffer.from(JSON.stringify(body));
    return new Promise<T>((resolve, reject) => {
      const req = https.request(
        {
          host: '127.0.0.1',
          port: ep.httpsPort,
          path: `/${SERVICE}/${method}`,
          method: 'POST',
          // The server uses a self-signed cert on localhost.
          rejectUnauthorized: false,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': payload.length,
            'x-codeium-csrf-token': ep.csrf,
          },
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c as Buffer));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            if ((res.statusCode ?? 0) >= 400) {
              reject(new Error(
                `Antigravity ${method} HTTP ${res.statusCode}: ${text.slice(0, 300)}`));
              return;
            }
            try {
              resolve(JSON.parse(text) as T);
            } catch {
              reject(new Error(`Antigravity ${method} bad JSON: ${text.slice(0, 200)}`));
            }
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error(`Antigravity ${method} timed out`)));
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  /**
   * Send a one-shot prompt to a model identified by its stable KEY (preferred)
   * or enum. Returns the model's text response.
   */
  async getModelResponse(prompt: string, modelKeyOrEnum: string,
    timeoutMs = 120_000): Promise<string> {
    const ep = await this.ensureRunning();
    const enumName = modelKeyOrEnum.startsWith('MODEL_')
      ? modelKeyOrEnum
      : await this.resolveModelEnum(modelKeyOrEnum, ep);
    const res = await this.rpc<{ response?: string }>(
      'GetModelResponse', { prompt, model: enumName }, ep, timeoutMs);
    const text = res.response ?? '';
    if (typeof text === 'string' && text.includes('no longer supported')) {
      throw new AntigravityVersionGateError(
        `Antigravity backend rejected the build (version gate). Server must run with ` +
        `--override_ide_version ${this.overrideIdeVersion}. Got: ${text}`);
    }
    return text;
  }

  /** Full model catalog as {key -> info}. */
  async getAvailableModels(ep?: AntigravityEndpoint): Promise<Map<string, AntigravityModelInfo>> {
    const endpoint = ep ?? (await this.ensureRunning());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = await this.rpc<{ response?: { models?: Record<string, any> } }>(
      'GetAvailableModels', {}, endpoint, 30_000);
    const models = data.response?.models ?? {};
    const out = new Map<string, AntigravityModelInfo>();
    for (const [key, v] of Object.entries(models)) {
      out.set(key, {
        key,
        enum: v.model,
        displayName: v.displayName ?? v.label ?? '',
        apiProvider: v.apiProvider,
        maxTokens: v.maxTokens,
      });
    }
    return out;
  }

  /**
   * Resolve a stable model KEY (or displayName) to the server's current enum.
   * Cached per endpoint. Throws if not found.
   */
  async resolveModelEnum(keyOrDisplayName: string, ep?: AntigravityEndpoint): Promise<string> {
    const cached = this.enumCache.get(keyOrDisplayName);
    if (cached) return cached;
    const endpoint = ep ?? (await this.ensureRunning());
    const catalog = await this.getAvailableModels(endpoint);

    const byKey = catalog.get(keyOrDisplayName);
    if (byKey?.enum) {
      this.enumCache.set(keyOrDisplayName, byKey.enum);
      return byKey.enum;
    }
    for (const info of catalog.values()) {
      if (info.displayName.toLowerCase() === keyOrDisplayName.toLowerCase() && info.enum) {
        this.enumCache.set(keyOrDisplayName, info.enum);
        return info.enum;
      }
    }
    throw new Error(
      `Antigravity model ${keyOrDisplayName} not found; available keys: ` +
      `${[...catalog.keys()].join(', ')}`);
  }

  /** Raw GetUserStatus (used by the usage meter). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getUserStatus(ep?: AntigravityEndpoint): Promise<any> {
    const endpoint = ep ?? (await this.ensureRunning());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = await this.rpc<{ userStatus?: any }>('GetUserStatus', {}, endpoint, 15_000);
    return data.userStatus ?? {};
  }

  // ---- mode A: discover a running hub ------------------------------------

  private async discoverRunningHub(): Promise<AntigravityEndpoint | null> {
    if (process.platform !== 'win32') return null;
    const ps =
      `$p = Get-CimInstance Win32_Process -Filter 'Name="language_server.exe"' | ` +
      `Where-Object { $_.CommandLine -match '--subclient_type hub' } | Select-Object -First 1; ` +
      `if (-not $p) { Write-Output 'NONE'; exit } ` +
      `$csrf = if ($p.CommandLine -match '--csrf_token (\\S+)') { $matches[1] } else { '' }; ` +
      `$ports = Get-NetTCPConnection -State Listen -OwningProcess $p.ProcessId -ErrorAction SilentlyContinue | ` +
      `Select-Object -ExpandProperty LocalPort | Sort-Object; ` +
      `Write-Output ($csrf + '|' + ($ports -join ','))`;
    const out = await this.runPowerShell(ps).catch(() => '');
    const line = out.trim();
    if (!line || line === 'NONE') return null;
    const [csrf, ports] = line.split('|');
    const portList = (ports || '').split(',').map((x) => parseInt(x, 10)).filter(Boolean);
    if (!csrf || portList.length === 0) return null;
    // Lower port = HTTPS, higher = HTTP.
    const httpsPort = Math.min(...portList);
    const ep: AntigravityEndpoint = { httpsPort, csrf, owned: false };
    return (await this.isHealthy(ep)) ? ep : null;
  }

  // ---- mode B: spawn our own --------------------------------------------

  private async spawnStandalone(): Promise<AntigravityEndpoint> {
    const binary = AntigravityServerManager.binaryPath();
    if (!fs.existsSync(binary)) {
      throw new Error(
        `Antigravity language server not found at ${binary}. Install Antigravity or ` +
        `open the Antigravity IDE.`);
    }
    if (!AntigravityServerManager.hasGeminiAuth()) {
      throw new Error(
        `No Antigravity/Gemini login found in ~/.gemini. Sign in via the Antigravity ` +
        `IDE first (nimbalyst does not perform the OAuth browser flow).`);
    }

    const csrf = `nimbalyst-${randomUUID()}`;

    const bindErrors: Array<{ port: number; reason: string }> = [];
    for (const port of this.spawnPortCandidates) {
      const args = [
        '--standalone',
        '--subclient_type', 'hub',
        '--override_ide_name', 'antigravity',
        '--override_ide_version', this.overrideIdeVersion,
        '--override_user_agent_name', 'antigravity',
        '--api_server_url', 'https://generativelanguage.googleapis.com',
        '--cloud_code_endpoint', 'https://daily-cloudcode-pa.googleapis.com',
        '--csrf_token', csrf,
        '--https_server_port', String(port),
        '--app_data_dir', 'antigravity',
        '--enable_sidecars',
      ];
      const child = spawn(binary, args, {
        stdio: ['ignore', 'ignore', 'pipe'],
        detached: false,
        windowsHide: true,
      });

      let stderrBuf = '';
      const STDERR_CAP = 16 * 1024;
      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderrBuf.length < STDERR_CAP) {
          stderrBuf += chunk.toString('utf8').slice(0, STDERR_CAP - stderrBuf.length);
        }
      });

      this.child = child;
      child.on('exit', () => {
        if (this.child === child) {
          this.child = null;
          this.endpoint = null;
          this.enumCache.clear();
        }
      });

      const ep: AntigravityEndpoint = { httpsPort: port, csrf, owned: true };
      const deadline = Date.now() + 60_000;
      let bindFailed = false;
      while (Date.now() < deadline) {
        if (child.exitCode !== null) {
          const reason = stderrBuf.trim() || `exit code ${child.exitCode}`;
          bindErrors.push({ port, reason: reason.slice(0, 500) });
          bindFailed = /bind|access permissions|address already in use|EADDRINUSE/i.test(stderrBuf);
          break;
        }
        if (await this.isHealthy(ep)) return ep;
        await delay(500);
      }

      if (!bindFailed && child.exitCode === null) {
        this.stop();
        throw new Error(
          `Antigravity language server did not become healthy on port ${port} within 60s`,
        );
      }
    }

    this.stop();
    const tried = bindErrors.map((e) => `${e.port}: ${e.reason.split('\n')[0]}`).join('; ');
    throw new Error(
      `Antigravity server exited early on all candidate ports. Tried: ${tried}`,
    );
  }


  /**
   * Spawn the standalone server under a cross-process lock so that, when
   * several backend module processes start together (the meta-agent spawns each
   * child session in its own worktree, and each workspace gets its own backend
   * module process), exactly ONE of them spawns the language server and the
   * rest discover and attach to it. Without this, two processes both miss
   * discovery during the spawn window and each launch a server; the pair share
   * --app_data_dir and the ~/.gemini OAuth and contend until GetModelResponse
   * times out.
   */
  private async spawnStandaloneSerialized(): Promise<AntigravityEndpoint> {
    const lockPath = AntigravityServerManager.SPAWN_LOCK_PATH;
    let holding = await acquireSpawnLock(lockPath);
    if (!holding) {
      // A live sibling is spawning. Wait for its server, then attach.
      const sibling = await this.waitForHub(AntigravityServerManager.SPAWN_WAIT_MS);
      if (sibling) return sibling;
      // Sibling stalled past the wait window: steal the lock and spawn
      // ourselves rather than deadlock this session.
      await releaseSpawnLock(lockPath);
      holding = await acquireSpawnLock(lockPath);
      if (!holding) {
        const late = await this.waitForHub(AntigravityServerManager.SPAWN_WAIT_MS);
        if (late) return late;
        // Last resort: spawn without the lock so the user is never stuck.
        return this.spawnStandalone();
      }
    }
    try {
      // A sibling may have finished spawning between our discovery miss and
      // taking the lock -- re-check before spawning a duplicate.
      const late = await this.discoverRunningHub();
      if (late) return late;
      return await this.spawnStandalone();
    } finally {
      await releaseSpawnLock(lockPath);
    }
  }

  /** Poll for a running hub (IDE or a sibling backend's server) until timeout. */
  private async waitForHub(timeoutMs: number): Promise<AntigravityEndpoint | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const ep = await this.discoverRunningHub();
      if (ep) return ep;
      await delay(1_000);
    }
    return null;
  }

  // ---- helpers -----------------------------------------------------------

  private async isHealthy(ep: AntigravityEndpoint): Promise<boolean> {
    try {
      await this.rpc('Heartbeat', {}, ep, 4_000);
      return true;
    } catch {
      return false;
    }
  }

  private runPowerShell(script: string): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        'powershell',
        ['-NoProfile', '-Command', script],
        { timeout: 30_000, windowsHide: true },
        (err, stdout) => (err ? reject(err) : resolve(stdout)),
      );
    });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
