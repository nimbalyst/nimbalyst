/**
 * The single place Wrangler is executed.
 *
 * Rules enforced here, not at call sites:
 *   - `execFile`, never `shell: true`. Arguments are an array, so a profile or
 *     account name can never be interpreted as shell syntax.
 *   - The environment is always {@link sanitizeWranglerEnv}'d.
 *   - The working directory is always Nimbalyst-owned, so no workspace `.env`
 *     is in scope.
 *   - Failures throw {@link SandboxOperationError} with a classified code; the
 *     raw output is classified and discarded without logging.
 */

import { execFile } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import { getEnhancedPath } from "../shellEnvironment";

import { classifyWranglerFailure, SandboxOperationError } from "./errors";
import { sanitizeWranglerEnv } from "./wranglerEnv";
import { getNeutralWorkingDir } from "./wranglerPaths";

/** Overridable for tests and for users with a non-PATH Wrangler. */
export const WRANGLER_BIN = process.env.NIMBALYST_WRANGLER_PATH || "wrangler";

export interface WranglerRunOptions {
  /** Working directory. Must be Nimbalyst-owned; defaults to the neutral dir. */
  cwd?: string;
  /** Milliseconds before the child is killed. */
  timeoutMs?: number;
  /**
   * Interactive commands (the SSO browser flow) need a long ceiling and must
   * not be treated as hung. Everything else uses the default.
   */
  interactive?: boolean;
}

export interface WranglerResult {
  stdout: string;
  stderr: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const INTERACTIVE_TIMEOUT_MS = 5 * 60_000;

/** Injection seam for tests. Production always uses {@link execFileRunner}. */
export type WranglerRunner = (
  args: string[],
  options: { cwd: string; env: Record<string, string>; timeoutMs: number }
) => Promise<WranglerResult>;

let runner: WranglerRunner = execFileRunner;

/** Test-only. Pass no argument to restore the real runner. */
export function setWranglerRunner(next?: WranglerRunner): void {
  runner = next ?? execFileRunner;
}

async function execFileRunner(
  args: string[],
  options: { cwd: string; env: Record<string, string>; timeoutMs: number }
): Promise<WranglerResult> {
  // Run the installed JS module with Electron's Node runtime. This also avoids
  // executing Windows .cmd shims through a shell or relying on a shebang's PATH.
  const modulePath = await resolveWranglerModulePath();
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [
        "-e",
        // yargs sees process.versions.electron even in ELECTRON_RUN_AS_NODE.
        // Mark this as a script invocation so hideBin drops both the binary
        // and script path, just as it does under the user's standalone Node.
        'process.defaultApp = true; require("node:module").runMain();',
        modulePath,
        ...args,
      ],
      {
        cwd: options.cwd,
        env: options.env,
        timeout: options.timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        // No `shell` key: execFile does not spawn a shell, which is the point.
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          const raw = `${error.message}\n${stderr ?? ""}`;
          reject(
            new SandboxOperationError(
              classifyWranglerFailure(raw),
              "wrangler-cli"
            )
          );
          return;
        }
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
      }
    );
  });
}

/**
 * Run Wrangler. `args` must already contain `--profile <name>` when the command
 * is profile-scoped; this function deliberately does not add it, so a caller
 * cannot forget it silently by relying on a default.
 */
export async function runWrangler(
  args: string[],
  options: WranglerRunOptions = {}
): Promise<WranglerResult> {
  const cwd = options.cwd ?? getNeutralWorkingDir();
  await fs.mkdir(cwd, { recursive: true });

  const env = sanitizeWranglerEnv(process.env, {
    PATH: getEnhancedPath(),
    ELECTRON_RUN_AS_NODE: "1",
    // Keep the child from emitting decorative output we would have to parse
    // around, and from phoning home on the user's behalf.
    //
    // This MUST be the string "true". Wrangler parses it as a strict boolean
    // and rejects "1" with `Expected WRANGLER_HIDE_BANNER to be "true" or
    // "false"` before it does anything else, which fails every command.
    WRANGLER_HIDE_BANNER: "true",
    WRANGLER_SEND_METRICS: "false",
    CI: "1",
    NO_COLOR: "1",
  });

  const timeoutMs =
    options.timeoutMs ??
    (options.interactive ? INTERACTIVE_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);

  return runner(args, { cwd, env, timeoutMs });
}

/** Strip ANSI escapes that survive `NO_COLOR` on some Wrangler code paths. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\[[0-9;]*m/g, "");
}

/**
 * Absolute path to the installed Wrangler module the control helper imports.
 *
 * The helper needs `getPlatformProxy`, which is a module export, but all we
 * know about is a CLI on PATH. Resolve the binary, walk up to the package root,
 * and read its entry point from `package.json`. Deriving it from the user's own
 * installation matters: importing some other copy of Wrangler would use a
 * different credential store than the CLI the user signed in with.
 */
export async function resolveWranglerModulePath(): Promise<string> {
  const binary = await realBinaryPath();
  let dir = path.dirname(binary);

  // npm uses text launchers instead of symlinks on Windows (and some package
  // managers do so elsewhere). Check the package locations beside that shim.
  const candidates = [
    path.join(dir, "node_modules", "wrangler"),
    path.join(dir, "..", "wrangler"),
  ];

  for (let depth = 0; depth < 6; depth += 1) {
    candidates.push(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const packageDir of candidates) {
    const manifestPath = path.join(packageDir, "package.json");
    try {
      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
      if (manifest?.name === "wrangler") {
        const entry =
          typeof manifest.main === "string"
            ? manifest.main
            : "wrangler-dist/cli.js";
        const modulePath = path.resolve(packageDir, entry);
        if ((await fs.stat(modulePath)).isFile()) return modulePath;
      }
    } catch {
      // Not a package root, or unreadable. Keep walking up.
    }
  }
  throw new SandboxOperationError(
    "wrangler-missing",
    "wrangler-module-resolve"
  );
}

async function realBinaryPath(): Promise<string> {
  if (WRANGLER_BIN.includes(path.sep)) return fs.realpath(WRANGLER_BIN);
  // `wrangler` came off PATH; resolve it the same way the shell would.
  const dirs = getEnhancedPath().split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const suffix of process.platform === "win32"
      ? [".cmd", ".exe", ""]
      : [""]) {
      const candidate = path.join(dir, WRANGLER_BIN + suffix);
      try {
        return await fs.realpath(candidate);
      } catch {
        // Not here.
      }
    }
  }
  throw new SandboxOperationError(
    "wrangler-missing",
    "wrangler-binary-resolve"
  );
}
