#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');

export const IDENTITY_SCOPE_ESCAPE = 'identity-scope-allow:';

/**
 * Pre-existing unscoped declarations, recorded so the gate can block NEW ones
 * without a 35-site rewrite landing in the same change. Keyed by file, then by
 * the exact trimmed source of the declaration -- deliberately not by line
 * number, so the entry survives edits elsewhere in the file but re-fires the
 * moment the declaration itself is touched. Editing one of these is the cue to
 * brand it and delete the entry, not to re-baseline it.
 *
 * This list should only ever get shorter.
 */
export const BASELINE_PATH = path.join(SCRIPT_DIR, 'identity-scope-baseline.json');

function loadBaseline(baselinePath = BASELINE_PATH) {
  if (!fs.existsSync(baselinePath)) return new Map();
  const raw = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  return new Map(Object.entries(raw).map(([file, sources]) => [file, sources]));
}

/**
 * A baselined entry is consumed once per occurrence, so a file listing one
 * `memberId: string` still fails when a second one appears next to it.
 */
function makeBaselineMatcher(baseline) {
  const remaining = new Map(
    [...baseline].map(([file, sources]) => [file, [...sources]]),
  );
  return (violation) => {
    const sources = remaining.get(violation.file);
    if (!sources) return false;
    const index = sources.indexOf(violation.source);
    if (index === -1) return false;
    sources.splice(index, 1);
    return true;
  };
}

export const DEFAULT_TARGETS = [
  'packages/runtime/src/sync',
  'packages/electron/src/main/services',
  'packages/electron/src/main/ipc',
  'packages/electron/src/shared/feedbackRequestIndex.ts',
  'packages/collab-client/src/core',
  'packages/collab-client/src/feedback',
  'packages/collab-bundle/src/editor',
];

// Match on the SHAPE of the name, not an allowlist of names. An exact-name list
// silently greenlights the next `memberId: string` / `authorUserId: string` /
// `sessionJwt: string` someone adds, which is the failure this gate exists to
// stop. Any identifier ending in userId/memberId (or containing jwt) counts.
const BARE_IDENTITY = /\b\w*(?:[Uu]serId|[Mm]emberId)\??\s*:\s*string\b/;
const BARE_JWT = /\b\w*[Jj]wt\??\s*:\s*string\b/;
const ERASED_GET_JWT = /\bgetJwt\??\s*:\s*\([^)]*\)\s*=>\s*Promise\s*<\s*string\s*>/;

function isSourceFile(filePath) {
  if (!/\.[cm]?tsx?$/.test(filePath)) return false;
  if (filePath.includes(`${path.sep}__tests__${path.sep}`)) return false;
  return !/\.(?:test|spec)\.[cm]?tsx?$/.test(filePath);
}

function collectSourceFiles(targetPath) {
  if (!fs.existsSync(targetPath)) return [];
  const stat = fs.statSync(targetPath);
  if (stat.isFile()) return isSourceFile(targetPath) ? [targetPath] : [];
  return fs.readdirSync(targetPath, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(targetPath, entry.name);
    return entry.isDirectory() ? collectSourceFiles(child) : (isSourceFile(child) ? [child] : []);
  });
}

function hasEscape(lines, lineIndex) {
  const start = Math.max(0, lineIndex - 2);
  return lines.slice(start, lineIndex + 1).some((line) => line.includes(IDENTITY_SCOPE_ESCAPE));
}

export function scanIdentityScopeViolations({
  root = REPO_ROOT,
  targets = DEFAULT_TARGETS,
  baseline = null,
} = {}) {
  const isBaselined = baseline ? makeBaselineMatcher(baseline) : () => false;
  const violations = [];
  for (const target of targets) {
    for (const filePath of collectSourceFiles(path.resolve(root, target))) {
      const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
      lines.forEach((line, lineIndex) => {
        const rule = BARE_IDENTITY.test(line)
          ? 'bare member identity'
          : BARE_JWT.test(line)
            ? 'bare JWT'
            : ERASED_GET_JWT.test(line)
              ? 'erased getJwt return type'
              : null;
        if (!rule || hasEscape(lines, lineIndex)) return;
        const violation = {
          file: path.relative(root, filePath),
          line: lineIndex + 1,
          rule,
          source: line.trim(),
        };
        if (isBaselined(violation)) return;
        violations.push(violation);
      });
    }
  }
  return violations;
}

export function formatIdentityScopeViolations(violations) {
  return violations.map((violation) =>
    `${violation.file}:${violation.line} ${violation.rule}: ${violation.source}`,
  ).join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const baseline = loadBaseline();
  const knownDebt = [...baseline.values()].reduce((sum, list) => sum + list.length, 0);
  const violations = scanIdentityScopeViolations({ baseline });
  if (violations.length > 0) {
    console.error('Identity scope check failed. Use TeamMemberId/PersonalMemberId and TeamJwt/PersonalJwt.');
    console.error(`For a genuinely scope-neutral boundary, add a nearby comment containing "${IDENTITY_SCOPE_ESCAPE}" and the reason.`);
    console.error(formatIdentityScopeViolations(violations));
    process.exitCode = 1;
  } else {
    console.log(`Identity scope check passed. ${knownDebt} pre-existing unscoped declarations remain in scripts/identity-scope-baseline.json.`);
  }
}
