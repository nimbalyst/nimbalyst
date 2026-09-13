import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, lstatSync, readlinkSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { npmSpawnConfig } from './run-workspace-script.mjs';

const markerName = '.nimbalyst-install.json';
const hash = (value) => createHash('sha256').update(value).digest('hex');

// Hash installed content too: npm's dependency listing detects missing packages,
// but does not detect a deleted declaration or a damaged compiler inside one.
export function installedDigest(directory) {
  const digest = createHash('sha256');
  function visit(dir, prefix = '') {
    for (const name of readdirSync(dir).sort()) {
      if (!prefix && name === markerName) continue;
      const relative = `${prefix}${name}`;
      const absolute = path.join(dir, name);
      const stat = lstatSync(absolute);
      digest.update(`${relative}\0${stat.mode}\0`);
      if (stat.isDirectory()) visit(absolute, `${relative}/`);
      else if (stat.isSymbolicLink()) {
        digest.update(readlinkSync(absolute));
        digest.update(readFileSync(absolute)); // Also reject broken executable links.
      } else if (stat.isFile()) digest.update(readFileSync(absolute));
      else throw new Error(`Unsupported installed file: ${relative}`);
    }
  }
  visit(directory);
  return digest.digest('hex');
}

export function ensureSandboxDependencies(directory, install = () => {
  const { command, argsPrefix } = npmSpawnConfig();
  const result = spawnSync(command, [...argsPrefix, 'ci', '--workspaces=false', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: directory, stdio: 'inherit' });
  if (result.error || result.status !== 0) throw result.error ?? new Error(`Sandbox npm ci exited ${result.status}`);
}) {
  const modules = path.join(directory, 'node_modules');
  const marker = path.join(modules, markerName);
  const inputs = hash([readFileSync(path.join(directory, 'package.json')), readFileSync(path.join(directory, 'package-lock.json')), process.versions.node, process.platform, process.arch].join('\0'));
  try {
    const previous = JSON.parse(readFileSync(marker, 'utf8'));
    if (previous.inputs === inputs && previous.installed === installedDigest(modules)) {
      console.log('[sandbox] Dependencies unchanged; skipping npm ci.');
      return false;
    }
  } catch { /* Missing, incomplete, or damaged installation: reinstall. */ }
  rmSync(marker, { force: true });
  install();
  writeFileSync(marker, `${JSON.stringify({ inputs, installed: installedDigest(modules) })}\n`);
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  ensureSandboxDependencies(fileURLToPath(new URL('../packages/cloudflare-sandbox', import.meta.url)));
}
