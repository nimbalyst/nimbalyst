import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getAppSetting } from '../utils/store';

function getProcessPathValue(): string {
  return process.env.PATH || process.env.Path || '';
}

function splitWindowsPathList(value: string | undefined | null): string[] {
  if (!value) return [];
  return value
    .split(';')
    .map(entry => entry.trim())
    .filter(Boolean);
}

function expandWindowsEnvVars(value: string): string {
  return value.replace(/%([^%]+)%/g, (_match, name: string) => {
    const envValue = process.env[name];
    return envValue ?? `%${name}%`;
  });
}

function normalizeWindowsPath(entry: string): string {
  const expanded = expandWindowsEnvVars(entry).replace(/^"(.*)"$/, '$1').trim();
  if (!expanded) return '';
  return path.win32.normalize(expanded).replace(/[\\\/]+$/, '').toLowerCase();
}

function dedupeWindowsPathEntries(entries: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const entry of entries) {
    const normalized = normalizeWindowsPath(entry);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(expandWindowsEnvVars(entry).replace(/^"(.*)"$/, '$1').trim());
  }

  return result;
}

function readWindowsRegistryPathEntries(registryKey: string): string[] {
  try {
    const result = execSync(`reg query "${registryKey}" /v Path`, {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const match = result.match(/Path\s+REG_(?:EXPAND_)?SZ\s+(.+)/i);
    if (!match?.[1]) {
      return [];
    }

    return splitWindowsPathList(match[1]);
  } catch {
    return [];
  }
}

function getWellKnownWindowsPathEntries(): string[] {
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const userProfile = process.env.USERPROFILE || process.env.HOME || os.homedir();
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';

  return [
    path.join(systemRoot, 'System32'),
    path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0'),
    path.join(programFiles, 'PowerShell', '7'),
    path.join(programFilesX86, 'PowerShell', '7'),
    path.join(programFiles, 'Git', 'bin'),
    path.join(programFiles, 'Git', 'cmd'),
    path.join(programFiles, 'Git', 'usr', 'bin'),
    path.join(programFilesX86, 'Git', 'bin'),
    path.join(programFilesX86, 'Git', 'cmd'),
    path.join(programFilesX86, 'Git', 'usr', 'bin'),
    path.join(programFiles, 'nodejs'),
    path.join(programFilesX86, 'nodejs'),
    path.join(appData, 'npm'),
    path.join(localAppData, 'Yarn', 'bin'),
    path.join(userProfile, 'AppData', 'Roaming', 'npm'),
    path.join(userProfile, 'scoop', 'shims'),
    path.join(userProfile, '.local', 'bin'),
    path.join(userProfile, '.bun', 'bin'),
    path.join(userProfile, '.deno', 'bin'),
    path.join(userProfile, '.volta', 'bin'),
    process.env.NVM_HOME || '',
    process.env.NVM_SYMLINK || '',
    process.env.FNM_DIR || '',
    'C:\\ProgramData\\chocolatey\\bin',
    'C:\\tools\\nodejs',
  ];
}

function getCustomWindowsPathEntries(): string[] {
  const customPathDirs = getAppSetting('customPathDirs');
  if (!customPathDirs || typeof customPathDirs !== 'string') {
    return [];
  }
  return splitWindowsPathList(customPathDirs);
}

export function getEnhancedWindowsPathEntries(): string[] {
  if (process.platform !== 'win32') {
    return [];
  }

  return dedupeWindowsPathEntries([
    ...getCustomWindowsPathEntries(),
    ...splitWindowsPathList(getProcessPathValue()),
    ...readWindowsRegistryPathEntries('HKCU\\Environment'),
    ...readWindowsRegistryPathEntries('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'),
    ...getWellKnownWindowsPathEntries(),
  ]);
}

export function getEnhancedWindowsPath(): string {
  return getEnhancedWindowsPathEntries().join(';');
}

export function findExecutableInWindowsPath(
  executableNames: string | string[],
  pathValue: string = getEnhancedWindowsPath()
): string | null {
  if (process.platform !== 'win32') {
    return null;
  }

  const executables = Array.isArray(executableNames) ? executableNames : [executableNames];
  const entries = splitWindowsPathList(pathValue);

  for (const entry of entries) {
    const cleanEntry = expandWindowsEnvVars(entry).replace(/^"(.*)"$/, '$1').trim();
    if (!cleanEntry) {
      continue;
    }

    for (const executable of executables) {
      const candidate = path.join(cleanEntry, executable);
      if (candidate && fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}
