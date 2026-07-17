import { isClaudeCodeFamily } from '@nimbalyst/runtime/ai/server/types';

export interface ProviderEnablement {
  enabled: boolean;
  /**
   * Optional per-provider allow-list. Empty or undefined means "allow all models
   * this provider offers" — the catalog is the source of truth. A non-empty list
   * restricts the picker to exactly those ids (plus the family conveniences below).
   */
  models?: string[];
  /**
   * Optional per-provider hide-list (denylist). Any model id here is hidden from
   * the picker regardless of the allow-list. Empty/undefined hides nothing, so a
   * newly shipped variant always appears until the user explicitly hides it — this
   * is the primary "trim the picker" control for the Claude Code family, which
   * keeps `models` empty (allow-all) on purpose (NIM-1486).
   */
  hiddenModels?: string[];
}

export interface FilterableModel {
  id: string;
  provider: string;
}

/**
 * Single gate deciding whether a catalog model reaches the picker. Extracted from
 * the `ai:getModels` handler so the behavior that once silently hid Fable 5 is
 * unit-tested (NIM-1486).
 *
 * The invariant that prevents recurrence: an empty/undefined allow-list means
 * "show everything". Since nothing curates the claude-code list, it stays empty
 * and every shipped variant is always visible. The special-cases below apply to
 * the whole Claude Code family (`claude-code` AND `claude-code-cli`) so the CLI
 * provider can't drift the way the SDK provider did.
 */
export function isModelEnabled(
  model: FilterableModel,
  entry: ProviderEnablement | undefined,
): boolean {
  if (!entry?.enabled) return false;

  // Denylist wins: a hidden id is never shown, even if it's also allow-listed.
  // Rows map 1:1 to picker rows, so hiding is per exact id (a base variant and
  // its -1m row are hidden independently).
  if (entry.hiddenModels && entry.hiddenModels.includes(model.id)) return false;

  const list = entry.models;
  if (list && list.length > 0) {
    if (isClaudeCodeFamily(model.provider)) {
      // Sentinel: the provider id itself in the list means "all of this provider".
      if (list.includes(model.provider)) return true;
      // Selecting a base variant implicitly enables its 1M extended-context row
      // (e.g. selecting `claude-code:sonnet` also surfaces `claude-code:sonnet-1m`).
      if (model.id.endsWith('-1m')) {
        const baseId = model.id.replace(/-1m$/, '');
        if (list.includes(baseId)) return true;
      }
    }
    return list.includes(model.id);
  }

  // Empty/undefined allow-list => allow all models for this provider.
  return true;
}
