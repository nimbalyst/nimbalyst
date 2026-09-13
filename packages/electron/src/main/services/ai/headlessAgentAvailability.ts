/**
 * Detects whether a headless CLI agent is not just installed but *usable*, and
 * caches the answer for the enablement gate.
 *
 * Why this exists: Grok Build and Cursor Agent are the only providers whose
 * default on/off state is decided by the machine rather than by a constant.
 * The naive way to do that is to detect at first boot and write
 * `enabled: true` into settings. That is a trap — the user turns the provider
 * off, the next launch detects it again, and the app overrides them. The bug
 * only ever appears on launch two.
 *
 * So nothing is persisted. This module answers "is it available right now?",
 * `resolveProviderEnabled()` uses that only as the fallback for a setting the
 * user has never touched, and an explicit `enabled: false` still wins through
 * the `??`. There is no first-boot decision to get stuck on.
 *
 * "Usable" means installed AND logged in. Both CLIs are commonly present but
 * signed out, and enabling on mere presence puts an agent in the model picker
 * that fails on the user's first turn.
 *
 * Gemini is the exception, and deliberately so. Antigravity is a vendor app at
 * a fixed path rather than a CLI on PATH, and its sign-in state is not on disk:
 * the credential is in the macOS keychain (service `gemini`, account
 * `antigravity`). Reading it would raise a keychain prompt, and the only other
 * way to ask is to spawn the ~120MB language server — too heavy for an
 * enablement gate that runs on every model-list read. So Gemini is detected on
 * presence, and a signed-out user gets one clear error on their first turn
 * instead (`GeminiAntigravityProvider.NOT_SIGNED_IN_MESSAGE`). Note this is
 * only marginally weaker than the CLI probes, which also match sign-out
 * negatively and answer "yes" to anything they do not recognize.
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AntigravityServerManager } from '@nimbalyst/runtime/ai/server/providers/geminiAntigravity/AntigravityServerManager';
import { scrubProviderApiKeys } from '@nimbalyst/runtime/ai/server/providerApiKeyScrub';

export type HeadlessAgentId = 'grok-build' | 'cursor-agent' | 'antigravity-gemini-agent';

/**
 * A CLI on the user's PATH whose sign-in state can be asked for directly.
 */
interface CliProbeSpec {
  kind: 'cli';
  executableName: string;
  homeRelativeInstallPaths: readonly string[];
  /** Argv for a cheap command that fails, or says so, when signed out. */
  authArgs: readonly string[];
  /**
   * Decide sign-in from the auth command's output.
   *
   * Neither CLI uses its exit code to report this: `grok models` exits 0 while
   * printing "You are not authenticated", and `cursor-agent status` exits 0
   * either way. So the text is the only signal, and it is matched
   * negatively — anything that looks like a sign-out message is a no, and
   * everything else is a yes. A vendor rewording their success string must not
   * silently disable the provider.
   */
  looksSignedOut: RegExp;
}

/**
 * A vendor application at a fixed absolute path, with no probeable sign-in.
 * Presence of the binary is the whole signal. See the module header.
 */
interface VendorAppProbeSpec {
  kind: 'vendor-app';
  /** Candidate absolute paths, resolved per platform at probe time. */
  resolvePath: () => string;
}

type AgentProbeSpec = CliProbeSpec | VendorAppProbeSpec;

const PROBE_SPECS: Readonly<Record<HeadlessAgentId, AgentProbeSpec>> = Object.freeze({
  'grok-build': {
    kind: 'cli' as const,
    executableName: 'grok',
    homeRelativeInstallPaths: ['.grok/bin/grok', '.local/bin/grok'],
    authArgs: ['models'],
    looksSignedOut: /not authenticated|not logged in|please (?:sign|log) in/i,
  },
  'cursor-agent': {
    kind: 'cli' as const,
    executableName: 'cursor-agent',
    homeRelativeInstallPaths: ['.local/bin/cursor-agent'],
    authArgs: ['status'],
    looksSignedOut: /not logged in|unauthorized|please (?:sign|log) in/i,
  },
  'antigravity-gemini-agent': {
    kind: 'vendor-app' as const,
    resolvePath: () => AntigravityServerManager.binaryPath(),
  },
});

export interface HeadlessAgentAvailability {
  installed: boolean;
  signedIn: boolean;
  /** Resolved executable, when found. */
  executablePath?: string;
}

/**
 * Pure decision, separated from the environment that produces it.
 *
 * The facts (does the binary exist, what did the auth command print) come from
 * a subprocess that a unit test cannot reproduce; the rule for turning those
 * facts into "available" is testable on its own.
 */
export function decideAvailability(
  agent: HeadlessAgentId,
  facts: { executablePath?: string; authOutput?: string; authFailed?: boolean },
): HeadlessAgentAvailability {
  if (!facts.executablePath) {
    return { installed: false, signedIn: false };
  }
  const spec = PROBE_SPECS[agent];
  if (spec.kind === 'vendor-app') {
    // Presence is the only signal available without a keychain prompt or a
    // server spawn. Reporting `signedIn: true` here is a statement about what
    // can be known, not a claim to have checked.
    return { installed: true, signedIn: true, executablePath: facts.executablePath };
  }
  if (facts.authFailed) {
    // The CLI is there but would not run. Treat as unusable rather than
    // guessing; a provider that errors on first use is worse than one absent.
    return { installed: true, signedIn: false, executablePath: facts.executablePath };
  }
  const signedOut = spec.looksSignedOut.test(facts.authOutput ?? '');
  return {
    installed: true,
    signedIn: !signedOut,
    executablePath: facts.executablePath,
  };
}

function findExecutable(spec: AgentProbeSpec, pathValue: string | undefined): string | undefined {
  if (spec.kind === 'vendor-app') {
    try {
      const resolved = spec.resolvePath();
      return fs.existsSync(resolved) ? resolved : undefined;
    } catch {
      return undefined;
    }
  }
  const home = os.homedir();
  const candidates: string[] = [];
  for (const relative of spec.homeRelativeInstallPaths) {
    candidates.push(path.join(home, ...relative.split('/')));
  }
  for (const entry of (pathValue ?? '').split(path.delimiter)) {
    const trimmed = entry.trim().replace(/^"(.*)"$/, '$1');
    if (trimmed) candidates.push(path.join(trimmed, spec.executableName));
  }
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // Unreadable path: keep looking.
    }
  }
  return undefined;
}

function runAuthProbe(
  executablePath: string,
  spec: CliProbeSpec,
  env: NodeJS.ProcessEnv,
): Promise<{ authOutput?: string; authFailed?: boolean }> {
  return new Promise((resolve) => {
    // An explicit callback rather than promisify: a `promisify.custom` on a
    // mocked child_process would bypass the spy at the test boundary.
    execFile(
      executablePath,
      [...spec.authArgs],
      { timeout: 10_000, env, encoding: 'utf8' },
      (error, stdout, stderr) => {
        const combined = `${stdout ?? ''}\n${stderr ?? ''}`;
        // A non-zero exit that still printed a recognizable sign-out message is
        // a sign-out, not a broken CLI.
        if (error && !combined.trim()) {
          resolve({ authFailed: true });
          return;
        }
        resolve({ authOutput: combined });
      },
    );
  });
}

const UNAVAILABLE: HeadlessAgentAvailability = Object.freeze({ installed: false, signedIn: false });

let cache: Partial<Record<HeadlessAgentId, HeadlessAgentAvailability>> = {};
let inFlight: Promise<void> | null = null;
let enhancedPathLoader: (() => string) | null = null;

/**
 * Injected from main-process startup rather than imported.
 *
 * A GUI-launched app has only `/usr/bin:/bin:/usr/sbin:/sbin` on PATH, which
 * misses every location either vendor installs to — so without the enhanced
 * PATH the probe reports "not installed" for a CLI that works fine in the
 * user's terminal. Injection (not a static `CLIManager` import) keeps this
 * module free of a cycle through the service layer.
 */
export function setHeadlessAgentEnhancedPathLoader(loader: (() => string) | null): void {
  enhancedPathLoader = loader;
}

/**
 * Cached answer for the synchronous enablement gate.
 *
 * Returns "unavailable" until the async probe has finished, so a provider
 * appears a beat after launch rather than blocking startup on two subprocess
 * spawns. `resolveProviderEnabled` is called on every model-list read, and it
 * cannot await.
 */
export function getCachedHeadlessAgentAvailability(agent: HeadlessAgentId): HeadlessAgentAvailability {
  return cache[agent] ?? UNAVAILABLE;
}

export function isHeadlessAgentAvailable(agent: string): boolean {
  if (!(agent in PROBE_SPECS)) return false;
  const availability = getCachedHeadlessAgentAvailability(agent as HeadlessAgentId);
  return availability.installed && availability.signedIn;
}

/**
 * Probe both agents and populate the cache. Safe to call repeatedly; concurrent
 * calls share one run.
 */
export function refreshHeadlessAgentAvailability(
  enhancedPathOverride?: string,
): Promise<void> {
  if (inFlight) return inFlight;

  const enhancedPath = enhancedPathOverride ?? safeLoadEnhancedPath();

  inFlight = (async () => {
    const env = scrubProviderApiKeys({ ...process.env, ...(enhancedPath ? { PATH: enhancedPath } : {}) });
    const next: Partial<Record<HeadlessAgentId, HeadlessAgentAvailability>> = {};

    await Promise.all((Object.keys(PROBE_SPECS) as HeadlessAgentId[]).map(async (agent) => {
      const spec = PROBE_SPECS[agent];
      const executablePath = findExecutable(spec, enhancedPath || process.env.PATH);
      if (!executablePath) {
        next[agent] = decideAvailability(agent, {});
        return;
      }
      if (spec.kind === 'vendor-app') {
        next[agent] = decideAvailability(agent, { executablePath });
        return;
      }
      try {
        const probe = await runAuthProbe(executablePath, spec, env);
        next[agent] = decideAvailability(agent, { executablePath, ...probe });
      } catch {
        next[agent] = decideAvailability(agent, { executablePath, authFailed: true });
      }
    }));

    cache = next;
  })().finally(() => {
    inFlight = null;
  });

  return inFlight;
}

function safeLoadEnhancedPath(): string | undefined {
  try {
    return enhancedPathLoader?.() || undefined;
  } catch {
    return undefined;
  }
}

export function __resetHeadlessAgentAvailabilityForTests(
  seed?: Partial<Record<HeadlessAgentId, HeadlessAgentAvailability>>,
): void {
  cache = seed ?? {};
  inFlight = null;
  enhancedPathLoader = null;
}
