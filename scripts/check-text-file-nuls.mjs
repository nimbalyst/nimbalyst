#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEXT_EXTENSIONS = new Set([
  '.bash', '.c', '.cc', '.cjs', '.cpp', '.cs', '.css', '.cts', '.csv',
  '.datamodel', '.editorconfig', '.entitlements', '.env', '.excalidraw',
  '.gql', '.go', '.gradle', '.graphql', '.h', '.hpp', '.htm', '.html',
  '.java', '.js', '.json', '.jsx', '.kt', '.kts', '.less', '.lock', '.m',
  '.md', '.mdx', '.mermaid', '.mindmap', '.mjs', '.mm', '.mts', '.plist',
  '.properties', '.proto', '.py', '.rb', '.rs', '.scss', '.sh', '.sql',
  '.storyboard', '.svelte', '.svg', '.swift', '.toml', '.ts', '.tsv',
  '.tsx', '.txt', '.vue', '.xib', '.xcconfig', '.xml', '.yaml', '.yml',
  '.zsh',
]);

const TEXT_BASENAMES = new Set([
  '.gitattributes',
  '.gitignore',
  '.npmrc',
  '.nvmrc',
  'dockerfile',
  'gemfile',
  'license',
  'makefile',
  'podfile',
  'rakefile',
]);

export function isTextLikePath(filePath) {
  const normalized = filePath.replaceAll('\\', '/');
  const basename = path.posix.basename(normalized).toLowerCase();
  return TEXT_BASENAMES.has(basename) || TEXT_EXTENSIONS.has(path.posix.extname(basename));
}

export function parseGitGrepPaths(output, ref) {
  const prefix = ref ? `${ref}:` : '';
  return output
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((entry) => (prefix && entry.startsWith(prefix) ? entry.slice(prefix.length) : entry))
    .filter(isTextLikePath)
    .sort();
}

export function findTrackedTextFilesWithNuls({ cwd = process.cwd(), ref } = {}) {
  const args = ['grep', '-a', '-l', '-z', '-P', '\\x00'];
  if (ref) args.push(ref);
  args.push('--');

  const result = spawnSync('git', args, { cwd });
  if (result.error) throw result.error;
  if (result.status === 1) return [];
  if (result.status !== 0) {
    throw new Error(result.stderr.toString('utf8').trim() || `git grep exited ${result.status}`);
  }

  return parseGitGrepPaths(result.stdout, ref);
}

function readRef(argv) {
  if (argv.length === 0) return undefined;
  if (argv.length === 2 && argv[0] === '--ref' && argv[1]) return argv[1];
  throw new Error('Usage: node scripts/check-text-file-nuls.mjs [--ref GIT_REF]');
}

function main() {
  let ref;
  try {
    ref = readRef(process.argv.slice(2));
  } catch (error) {
    console.error(`[text-nuls] ${error.message}`);
    process.exitCode = 2;
    return;
  }

  const violations = findTrackedTextFilesWithNuls({ ref });
  if (violations.length === 0) {
    console.log(`[text-nuls] no raw NUL bytes in tracked text files${ref ? ` at ${ref}` : ''}.`);
    return;
  }

  console.error('[text-nuls] raw NUL bytes found in tracked text files:');
  for (const file of violations) console.error(`  ${file}`);
  console.error('[text-nuls] use a source escape such as \\u0000 or \\x00 instead.');
  process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
