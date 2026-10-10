import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { ExtensionLogService } from '../services/ExtensionLogService';

export interface ExtensionBuildResult {
  success: boolean;
  stdout: string;
  stderr: string;
}

/**
 * The package manager that owns an extension project. A pnpm project may forbid
 * npm outright (`devEngines.packageManager`), so `npm run build` would fail
 * there. Built-in extensions inherit the monorepo's pnpm lockfile from an
 * ancestor directory; anything without a pnpm signal keeps using npm.
 */
export function detectExtensionPackageManager(extensionPath: string): 'pnpm' | 'npm' {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(extensionPath, 'package.json'), 'utf8'));
    if (typeof pkg.packageManager === 'string') {
      return pkg.packageManager.startsWith('pnpm@') ? 'pnpm' : 'npm';
    }
    if (pkg.devEngines?.packageManager?.name === 'pnpm') return 'pnpm';
  } catch {
    // The caller reports a missing or unreadable package.json.
  }
  for (let dir = path.resolve(extensionPath); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'pnpm-lock.yaml')) || fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
      return 'pnpm';
    }
    if (fs.existsSync(path.join(dir, 'package-lock.json')) || fs.existsSync(path.join(dir, '.git'))) {
      return 'npm';
    }
    if (path.dirname(dir) === dir) return 'npm';
  }
}

/** Run an extension's package build and stream its output to Extension Dev logs. */
export async function runExtensionBuild(
  extensionPath: string,
): Promise<ExtensionBuildResult> {
  const packageJsonPath = path.join(extensionPath, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    return {
      success: false,
      stdout: '',
      stderr: `Error: No package.json found at ${extensionPath}`,
    };
  }

  let extensionId: string | undefined;
  const manifestPath = path.join(extensionPath, 'manifest.json');
  try {
    if (fs.existsSync(manifestPath)) {
      extensionId = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).id;
    }
  } catch {
    // Manifest validation reports malformed metadata after the build.
  }

  const logService = ExtensionLogService.getInstance();
  logService.addMainLog(
    'info',
    `Starting build for extension: ${extensionId || extensionPath}`,
    extensionId,
  );

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeoutRef: { current?: ReturnType<typeof setTimeout> } = {};

    const finish = (result: ExtensionBuildResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutRef.current);
      resolve(result);
    };

    const child = spawn(detectExtensionPackageManager(extensionPath), ['run', 'build'], {
      cwd: extensionPath,
      shell: true,
      env: { ...process.env, FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout.on('data', (data) => {
      const chunk = data.toString();
      stdout += chunk;
      if (extensionId) logService.addBuildLog(extensionId, chunk, false);
    });

    child.stderr.on('data', (data) => {
      const chunk = data.toString();
      stderr += chunk;
      if (extensionId) logService.addBuildLog(extensionId, chunk, true);
    });

    child.on('close', (code) => {
      const success = code === 0;
      logService.addMainLog(
        success ? 'info' : 'error',
        `Build ${success ? 'succeeded' : 'failed'} for extension: ${extensionId || extensionPath}`,
        extensionId,
      );
      finish({ success, stdout, stderr });
    });

    child.on('error', (error) => {
      logService.addMainLog('error', `Build process error: ${error.message}`, extensionId);
      finish({ success: false, stdout, stderr: `${stderr}\n${error.message}` });
    });

    timeoutRef.current = setTimeout(() => {
      child.kill();
      logService.addMainLog('error', 'Build timed out after 60 seconds', extensionId);
      finish({
        success: false,
        stdout,
        stderr: `${stderr}\nBuild timed out after 60 seconds`,
      });
    }, 60_000);
  });
}
