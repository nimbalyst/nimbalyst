import { CLAUDE_CODE_VARIANTS, ModelIdentifier } from '@nimbalyst/runtime/ai/server/types';

/**
 * The full set of shipped Claude Code base-variant model ids, derived from the
 * single source of truth (`CLAUDE_CODE_VARIANTS`). This is the canonical enabled
 * list for a fresh install, and the catalog the saved allow-list is reconciled
 * against — so a newly-added variant can never be silently dropped from the
 * picker again (the drift that hid Fable 5 and sonnet-4-6).
 */
export function claudeCodeCatalogModelIds(): string[] {
  return CLAUDE_CODE_VARIANTS.map((v) => ModelIdentifier.create('claude-code', v).combined);
}

/** Default enabled claude-code models for a fresh install (whole catalog). */
export const DEFAULT_CLAUDE_CODE_MODELS: string[] = claudeCodeCatalogModelIds();

export interface ReconcileResult {
  /** The user's allow-list after back-filling any newly-shipped variants. */
  models: string[];
  /** The snapshot of variants to persist as "known" for next reconciliation. */
  known: string[];
  /** Whether `models` changed (i.e. a write is needed). */
  changed: boolean;
}

/**
 * Reconcile a user's saved claude-code allow-list against the shipped catalog.
 *
 * Any catalog variant not present in `known` (the persisted snapshot of variants
 * we've reconciled before) is treated as newly-shipped and enabled by default.
 * Variants already in `known` are left untouched, so a deliberate user opt-out is
 * never re-enabled.
 *
 * First run on an existing install (`known` undefined) treats everything the user
 * doesn't already have as new — this is what back-fills variants (fable,
 * sonnet-4-6) that shipped before this reconciliation existed. This matches the
 * intent of the previous per-variant insertion migrations.
 */
export function reconcileClaudeCodeModels(
  current: string[],
  known: string[] | undefined,
  catalog: string[] = claudeCodeCatalogModelIds(),
): ReconcileResult {
  const knownSet = new Set(known ?? []);
  const currentSet = new Set(current);
  const additions = catalog.filter((id) => !knownSet.has(id) && !currentSet.has(id));
  // Remember the union so a variant later dropped from the catalog isn't treated
  // as brand new if it returns.
  const nextKnown = Array.from(new Set([...(known ?? []), ...catalog]));
  return {
    models: additions.length > 0 ? [...current, ...additions] : current,
    known: nextKnown,
    changed: additions.length > 0,
  };
}
