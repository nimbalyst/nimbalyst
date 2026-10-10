/**
 * The vocabulary half of `tracker_define_type`: the `predicates` argument.
 *
 * It MERGES BY ID into the local copy (`.nimbalyst/predicates.yaml`): an entry
 * replaces the entry with its id or is appended, and entries the caller omits
 * are kept. Replacing the whole registry, which `predicates` used to do, made
 * two agents extending the vocabulary at once clobber each other; merge-by-id
 * makes their additions commute. Deletion is explicit (`removePredicates`), and
 * anything the classifier cannot prove additive needs `confirmDestructive`,
 * because it invalidates values already written on teammates' items. The
 * classification only gates; any canonical difference is written, so a
 * rename or a new description is not dropped as "no change".
 *
 * The earlier knowledge graph's label registry (`.nimbalyst/labels.yaml`) is
 * no longer authored here; an existing one still loads and syncs.
 */

import {
  classifyPredicateRegistryChanges,
  destructivePredicateRegistryChanges,
  validatePredicateRegistry,
  type PredicateDefinition,
} from '@nimbalyst/tracker-schema';
import { canonicalPredicateRegistryJson } from '@nimbalyst/runtime/plugins/TrackerPlugin/models/predicateRegistryMerge';
import { applyWorkspacePredicateRegistryInProcess } from '../../services/TrackerSchemaService';
import {
  readWorkspacePredicateRegistry,
  writeWorkspacePredicateRegistry,
} from '../../services/tracker/trackerPredicateRegistryFile';
import type { McpToolResult } from './trackerToolResult';

type Outcome<T> = { error: McpToolResult } | ({ summary: string } & T);

function errorResult(text: string): { error: McpToolResult } {
  return { error: { content: [{ type: 'text', text }], isError: true } };
}

function issueList(issues: ReadonlyArray<{ code: string; path: string; message: string }>): string {
  return issues.map(issue => `- ${issue.code} at '${issue.path}': ${issue.message}`).join('\n');
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/**
 * Merge `args.predicates` (upserts) and `args.removePredicates` (ids) into the
 * registry. Returns the resulting registry.
 */
export async function applyPredicateRegistryArgs(
  workspacePath: string,
  args: any,
): Promise<Outcome<{ applied: PredicateDefinition[] }>> {
  const validation = validatePredicateRegistry(Array.isArray(args?.predicates) ? args.predicates : []);
  if (!validation.valid) {
    return errorResult(`Error: invalid predicate registry.\n${issueList(validation.issues)}`);
  }
  const current = readWorkspacePredicateRegistry(workspacePath);
  if (current === null) {
    return errorResult('Error: .nimbalyst/predicates.yaml is invalid; fix it before merging predicates into it.');
  }

  const removed = stringList(args?.removePredicates);
  const next = current.filter(predicate => !removed.includes(predicate.id));
  for (const predicate of validation.predicates) {
    const at = next.findIndex(existing => existing.id === predicate.id);
    if (at >= 0) next[at] = predicate;
    else next.push(predicate);
  }

  const { classification, changes } = classifyPredicateRegistryChanges(current, next);
  if (classification === 'destructive' && args?.confirmDestructive !== true) {
    return errorResult(
      `This predicate registry change is destructive and needs \`confirmDestructive: true\`:\n${destructivePredicateRegistryChanges(changes)
        .map(change => `- ${change.kind} on '${change.predicateId}'`)
        .join('\n')}\nStatements already written under these predicates stop validating.`,
    );
  }

  // The classifier only sees what can invalidate stored values; a relabel is
  // still an edit. Whether to write is canonical equality.
  const changed = canonicalPredicateRegistryJson(next) !== canonicalPredicateRegistryJson(current);
  if (changed) {
    await writeWorkspacePredicateRegistry(workspacePath, next);
    applyWorkspacePredicateRegistryInProcess(workspacePath, next);
  }
  return {
    applied: next,
    summary: !changed
      ? `Predicate registry unchanged (${next.length} predicate(s)).`
      : `Merged into .nimbalyst/predicates.yaml: ${next.length} predicate(s) (${classification === 'none' ? 'presentation' : classification} change).`,
  };
}
