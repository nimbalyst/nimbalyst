/**
 * The checks on the Checks tab, in order: plain JSON, the hooks schema, and
 * the script files. After the first failure the later checks are skipped,
 * because their answers would mean nothing.
 */

import { REQUIRED_FIELDS } from './compatibility';
import { openHookDocument, scriptPathsOf, type HookDocument } from './hookDocument';
import { isHookType, isJsonObject, type JsonValue } from './types';

export type CheckName = 'json' | 'schema' | 'scripts';

export interface CheckResult {
  check: CheckName;
  status: 'passed' | 'failed' | 'skipped';
  problems: string[];
}

export interface CheckInput {
  /** The text the save would write. */
  text: string;
  /** The document behind the text: its source, hook launcher path and scripts. */
  document: HookDocument;
  /** The script files the save would write. They count as present. */
  scriptWrites: ReadonlyArray<{ path: string }>;
  /** True when a script file is on disk. */
  fileExists: (path: string) => boolean;
}

/**
 * The shape Claude Code reads. Unknown events and unknown hook types pass:
 * they may come from a newer Claude Code, and the editor keeps them as they are.
 */
function schemaProblems(hooks: JsonValue | undefined): string[] {
  if (hooks === undefined) return [];
  if (!isJsonObject(hooks)) return ['"hooks" must be an object.'];
  const problems: string[] = [];
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      problems.push(`hooks.${event} must be a list.`);
      continue;
    }
    groups.forEach((group, groupIndex) => {
      const at = `hooks.${event}[${groupIndex}]`;
      const list = isJsonObject(group) ? group.hooks : undefined;
      if (!isJsonObject(group) || !Array.isArray(list)) {
        problems.push(`${at} must be an object with a "hooks" list.`);
        return;
      }
      if (group.matcher !== undefined && typeof group.matcher !== 'string') problems.push(`${at}.matcher must be text.`);
      list.forEach((entry, hookIndex) => {
        const where = `${at}.hooks[${hookIndex}]`;
        if (!isJsonObject(entry) || typeof entry.type !== 'string') {
          problems.push(`${where} needs a "type".`);
          return;
        }
        if (isHookType(entry.type)) {
          for (const name of REQUIRED_FIELDS[entry.type]) {
            if (typeof entry[name] !== 'string' || entry[name] === '') problems.push(`${where} needs "${name}".`);
          }
        }
        const { timeout } = entry;
        if (timeout !== undefined && !(typeof timeout === 'number' && timeout > 0)) {
          problems.push(`${where}.timeout must be a number of seconds above 0.`);
        }
      });
    });
  }
  return problems;
}

function missingScripts(document: HookDocument, input: CheckInput): string[] {
  const pending = new Set(input.scriptWrites.map((write) => write.path));
  return scriptPathsOf(document)
    .filter((path) => !pending.has(path) && !input.fileExists(path))
    .map((path) => `Script file not found: ${path}`);
}

export function runChecks(input: CheckInput): CheckResult[] {
  const opened = openHookDocument(input.text, {
    source: input.document.source,
    launcherPath: input.document.launcherPath ?? undefined,
    scriptTexts: input.document.scripts,
  });
  const steps: Array<[CheckName, () => string[]]> = [
    ['json', () => (opened.ok ? [] : [opened.reason])],
    ['schema', () => (opened.ok ? schemaProblems(opened.document.hooks) : [])],
    ['scripts', () => (opened.ok ? missingScripts(opened.document, input) : [])],
  ];
  const results: CheckResult[] = [];
  let failed = false;
  for (const [check, problemsOf] of steps) {
    if (failed) {
      results.push({ check, status: 'skipped', problems: [] });
      continue;
    }
    const problems = problemsOf();
    failed = problems.length > 0;
    results.push({ check, status: failed ? 'failed' : 'passed', problems });
  }
  return results;
}
