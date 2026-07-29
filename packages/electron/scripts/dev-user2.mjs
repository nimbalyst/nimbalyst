import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ELECTRON_DIR = path.dirname(SCRIPT_DIR);
const EXTENSION_SDK_DIR = path.resolve(ELECTRON_DIR, '..', 'extension-sdk');
const require = createRequire(import.meta.url);

export function resolveUser2DataDir({
  platform = process.platform,
  environment = process.env,
  homeDirectory = homedir(),
} = {}) {
  if (platform === 'win32') {
    const appData = environment.APPDATA || path.join(homeDirectory, 'AppData', 'Roaming');
    return path.join(appData, '@nimbalyst', 'electron-user2');
  }

  if (platform === 'darwin') {
    return path.join(homeDirectory, 'Library', 'Application Support', '@nimbalyst', 'electron-user2');
  }

  const configHome = environment.XDG_CONFIG_HOME || path.join(homeDirectory, '.config');
  return path.join(configHome, '@nimbalyst', 'electron-user2');
}

export function createUser2Environment(options = {}) {
  const environment = options.environment ?? process.env;
  const userDataDir = resolveUser2DataDir({ ...options, environment });

  return {
    ...environment,
    NIMBALYST_USER_DATA_DIR: userDataDir,
    VITE_PORT: '5274',
    ELECTRON_ENTRY: 'out2/main/index.js',
  };
}

export function resolvePackageBinary(packageName, binaryName = packageName) {
  const packageJsonPath = require.resolve(`${packageName}/package.json`);
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  const binaryPath = typeof packageJson.bin === 'string'
    ? packageJson.bin
    : packageJson.bin?.[binaryName];

  if (!binaryPath) {
    throw new Error(`Package "${packageName}" does not define the "${binaryName}" binary`);
  }

  return path.resolve(path.dirname(packageJsonPath), binaryPath);
}

export function restartSignalPath(userDataDir, electronDir = ELECTRON_DIR) {
  return path.join(electronDir, `.restart-requested-${path.basename(userDataDir)}`);
}

function run(command, args, environment, cwd = ELECTRON_DIR) {
  const result = spawnSync(command, args, {
    cwd,
    env: environment,
    stdio: 'inherit',
  });

  if (result.error) {
    console.error(`[dev:user2] Failed to start ${command}:`, result.error);
    return 1;
  }

  return result.status ?? 1;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function runUser2({ loop = false } = {}) {
  const environment = createUser2Environment();
  const userDataDir = environment.NIMBALYST_USER_DATA_DIR;
  const restartSignal = restartSignalPath(userDataDir);
  const typescript = resolvePackageBinary('typescript', 'tsc');
  const workerBuild = path.join(ELECTRON_DIR, 'build', 'build-worker.js');
  const electronVite = resolvePackageBinary('electron-vite');

  console.log(`[dev:user2] Using userData directory: ${userDataDir}`);
  console.log('[dev:user2] Using Vite port 5274 and isolated build output: out2/');
  console.log('[dev:user2] Building @nimbalyst/extension-sdk...');

  const sdkStatus = run(
    process.execPath,
    [typescript, '--project', path.join(EXTENSION_SDK_DIR, 'tsconfig.json')],
    environment,
    EXTENSION_SDK_DIR,
  );
  if (sdkStatus !== 0) return sdkStatus;

  if (loop && existsSync(restartSignal)) {
    unlinkSync(restartSignal);
  }

  do {
    const workerStatus = run(process.execPath, [workerBuild], environment);
    if (workerStatus !== 0) return workerStatus;

    const devStatus = run(process.execPath, [electronVite, 'dev', '--outDir=out2'], environment);
    if (!loop || !existsSync(restartSignal)) return devStatus;

    unlinkSync(restartSignal);
    console.log('[dev:user2] Restart requested; relaunching in 2 seconds...');
    await delay(2000);
  } while (true);
}

const isDirectRun = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  const status = await runUser2({ loop: process.argv.includes('--loop') });
  process.exit(status);
}
