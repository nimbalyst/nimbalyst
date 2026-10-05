/**
 * Pure matching for Settings search (#1574). No React, so the ranking rules
 * are testable without rendering.
 */

import type { SettingsSearchEntry } from './settingsSearchIndex';

/** A page the sidebar currently offers; already filtered by availability. */
export interface SettingsSearchPage {
  id: string;
  label: string;
}

export type SettingsSearchResult =
  | { kind: 'page'; category: string; label: string }
  | { kind: 'setting'; category: string; anchor: string; name: string; description?: string; pageLabel: string };

// Lower ranks first. A page is where people expect to land when their words
// name one; a setting's own name beats a keyword, which beats its description.
const RANK = { page: 0, name: 1, keyword: 2, description: 3 } as const;

function tokenize(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

function containsAll(haystack: string, tokens: string[]): boolean {
  const lower = haystack.toLowerCase();
  return tokens.every((token) => lower.includes(token));
}

/**
 * Every word must match somewhere in the item, in any order. Settings on a
 * page missing from `pages` are dropped, so search never offers a setting the
 * sidebar is hiding (developer-only pages, hidden chat providers, Teams).
 */
export function searchSettings(
  query: string,
  pages: readonly SettingsSearchPage[],
  entries: readonly SettingsSearchEntry[],
): SettingsSearchResult[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];

  const pageLabels = new Map(pages.map((page) => [page.id, page.label]));
  const ranked: Array<{ rank: number; order: number; result: SettingsSearchResult }> = [];

  pages.forEach((page, order) => {
    if (containsAll(page.label, tokens)) {
      ranked.push({ rank: RANK.page, order, result: { kind: 'page', category: page.id, label: page.label } });
    }
  });

  entries.forEach((entry, index) => {
    const pageLabel = pageLabels.get(entry.category);
    if (pageLabel === undefined) return;
    const keywords = (entry.keywords ?? []).join(' ');
    const all = `${entry.name} ${keywords} ${entry.description ?? ''}`;
    if (!containsAll(all, tokens)) return;

    const rank = containsAll(entry.name, tokens)
      ? RANK.name
      : containsAll(`${entry.name} ${keywords}`, tokens)
        ? RANK.keyword
        : RANK.description;
    ranked.push({
      rank,
      order: pages.length + index,
      result: {
        kind: 'setting',
        category: entry.category,
        anchor: entry.anchor,
        name: entry.name,
        description: entry.description,
        pageLabel,
      },
    });
  });

  return ranked
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .map(({ result }) => result);
}
