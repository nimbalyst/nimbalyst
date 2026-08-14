/**
 * Spellchecker language resolution.
 *
 * Nimbalyst only ever called `session.setSpellCheckerEnabled(bool)` and never
 * `setSpellCheckerLanguages(...)`, so Chromium fell back to its own default
 * (en-US) regardless of the user's OS locale. A user on `en_CA` therefore saw
 * US/UK spelling flagged. This module decides which language(s) to hand
 * Chromium, preferring an explicit user choice, then the system locale.
 *
 * Kept pure (no `electron` import) so it is unit-testable without building the
 * app. The main process supplies `session.availableSpellCheckerLanguages` and
 * the locale; this decides the list.
 *
 * Note: on macOS Electron uses the OS spellchecker and `setSpellCheckerLanguages`
 * is a no-op — callers skip it there. This module is for Windows/Linux.
 */

/**
 * Normalize a locale string to a Chromium BCP-47 spellcheck code.
 *   "en_CA.UTF-8" | "en_CA" | "en-ca" -> "en-CA"
 *   "en"                              -> "en"
 *   "" | "C" | "POSIX" | junk         -> undefined
 */
export function normalizeLocale(locale: string | undefined | null): string | undefined {
  if (!locale) return undefined;
  // Strip encoding (".UTF-8") and modifier ("@euro"); unify separator.
  const cleaned = locale.split('.')[0].split('@')[0].replace('_', '-').trim();
  if (!cleaned) return undefined;
  const parts = cleaned.split('-');
  const lang = parts[0].toLowerCase();
  // "C"/"POSIX" and other non-language values fail this shape check.
  if (!/^[a-z]{2,3}$/.test(lang)) return undefined;
  if (parts.length === 1) return lang;
  const region = parts[1].toUpperCase();
  if (!/^[A-Z]{2}$/.test(region)) return lang; // e.g. "en-latn" -> "en"
  return `${lang}-${region}`;
}

/**
 * Resolve the spellchecker language list.
 *
 * Priority:
 *   1. Explicit saved preference (filtered to what Chromium actually offers).
 *   2. The system locale, if Chromium offers it exactly (e.g. "en-CA").
 *   3. The locale's base language matched to the first available regional
 *      variant (e.g. "en-CA" with only "en-US" available -> "en-US"), so a
 *      Canadian is never dropped to *no* English rather than a near one.
 *   4. [] — assert nothing; Chromium keeps its own default (never worse than
 *      today's behavior).
 *
 * When `available` is empty (the list is unknown at call time) we DO NOT filter
 * to empty — we trust the saved/locale value, since filtering against an empty
 * "what's available" set would wrongly reject everything.
 */
export function resolveSpellCheckerLanguages(
  locale: string | undefined | null,
  available: readonly string[] | undefined | null,
  saved?: readonly string[] | undefined | null,
): string[] {
  const avail = (available ?? []).filter((c): c is string => typeof c === 'string' && c.length > 0);
  const availUnknown = avail.length === 0;
  const has = (code: string) =>
    availUnknown || avail.some((c) => c.toLowerCase() === code.toLowerCase());
  const canonical = (code: string) =>
    avail.find((c) => c.toLowerCase() === code.toLowerCase()) ?? code;

  // 1) explicit saved preference wins
  if (saved && saved.length > 0) {
    const kept = dedupe(
      saved
        .filter((c): c is string => typeof c === 'string' && c.length > 0)
        .filter((c) => has(c))
        .map(canonical),
    );
    if (kept.length > 0) return kept;
    // saved but none available -> fall through to locale
  }

  // 2 / 3) system locale
  const norm = normalizeLocale(locale ?? undefined);
  if (norm) {
    if (has(norm)) return [canonical(norm)];
    const base = norm.split('-')[0].toLowerCase();
    // prefer a regional variant of the same base language ("en-*")...
    const regional = avail.find((c) => c.toLowerCase().startsWith(base + '-'));
    if (regional) return [regional];
    // ...else the bare base language if Chromium has it.
    if (has(base)) return [canonical(base)];
  }

  // 4) nothing we can assert — leave Chromium's default in place
  return [];
}

function dedupe(arr: readonly string[]): string[] {
  return [...new Set(arr)];
}
