/**
 * The checks on the Checks tab, in order: plain JSON, the hooks schema, and
 * the script files. After the first failure the later checks are skipped,
 * because their answers would mean nothing.
 */

import { z } from 'zod';

import { REQUIRED_FIELDS } from './compatibility';
import { openHookDocument, scriptPathsOf, type HookDocument } from './hookDocument';
import { isHookType, type JsonValue } from './types';

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

const requiredText = z.string().min(1);
const timeoutSeconds = z.number().positive().optional();

/** One hook: it needs a "type". The fields and the time limit depend on that type. */
const hookEntrySchema = z.looseObject({ type: z.string() }).superRefine((entry, ctx) => {
  // These issues carry only the end of the sentence. `describeIssue` puts the place in front.
  if (isHookType(entry.type)) {
    for (const name of REQUIRED_FIELDS[entry.type]) {
      if (!requiredText.safeParse(entry[name]).success) {
        ctx.addIssue({ code: 'custom', path: [name], message: ` needs "${name}".` });
      }
    }
  }
  if (!timeoutSeconds.safeParse(entry.timeout).success) {
    ctx.addIssue({ code: 'custom', path: ['timeout'], message: '.timeout must be a number of seconds above 0.' });
  }
});

/**
 * The shape Claude Code reads. Unknown events and unknown hook types pass:
 * they may come from a newer Claude Code, and the editor keeps them as they are.
 */
const hooksSchema = z.record(
  z.string(),
  z.array(z.looseObject({ matcher: z.string().optional(), hooks: z.array(hookEntrySchema) })),
);

/** The plain sentence for one problem the schema found. The path says where in "hooks" it sits. */
function describeIssue(issue: z.core.$ZodIssue): string {
  const [event, groupIndex, groupKey, hookIndex] = issue.path;
  const group = `hooks.${String(event)}[${String(groupIndex)}]`;
  const hook = `${group}.hooks[${String(hookIndex)}]`;
  switch (issue.path.length) {
    case 0:
      return '"hooks" must be an object.';
    case 1:
      return `hooks.${String(event)} must be a list.`;
    case 2:
      return `${group} must be an object with a "hooks" list.`;
    case 3:
      return groupKey === 'matcher' ? `${group}.matcher must be text.` : `${group} must be an object with a "hooks" list.`;
    case 4:
      return `${hook} needs a "type".`;
    default:
      return issue.path[4] === 'type' ? `${hook} needs a "type".` : `${hook}${issue.message}`;
  }
}

function schemaProblems(hooks: JsonValue | undefined): string[] {
  if (hooks === undefined) return [];
  const result = hooksSchema.safeParse(hooks);
  if (result.success) return [];
  const groupOf = (issue: z.core.$ZodIssue) => issue.path.slice(0, 2).join('.');
  // A group that is not an object with a "hooks" list reports once. Its matcher is not looked at.
  const brokenGroups = new Set(
    result.error.issues
      .filter((issue) => issue.path.length === 2 || (issue.path.length === 3 && issue.path[2] === 'hooks'))
      .map(groupOf),
  );
  return result.error.issues
    .filter((issue) => issue.path[2] !== 'matcher' || !brokenGroups.has(groupOf(issue)))
    .map(describeIssue);
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
