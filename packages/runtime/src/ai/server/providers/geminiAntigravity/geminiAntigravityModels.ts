/**
 * Model catalog for the `antigravity-gemini-agent` provider.
 *
 * The language server DOES enumerate models -- `GetAvailableModels` returns the
 * full catalog and `GetUserStatus.cascadeModelConfigData.clientModelConfigs`
 * returns the subset the signed-in account may actually use. When the extension
 * owned this provider its manifest hardcoded three model ids, and by the time
 * this moved in-tree that list was already stale: the live catalog carried a
 * Gemini 3.6 Flash family the picker never offered. That drift is exactly
 * NIM-1486, so discovery is the primary source and the seed list below is only
 * a fallback.
 *
 * Discovery never spawns the server. Enumerating models is a passive act (the
 * user opened a picker), and starting a ~120MB language server for it would be
 * a surprising side effect -- so when no endpoint is live the seed list is
 * returned and discovery fills in after the first real turn. Same posture as
 * `GrokBuildProvider.listModelIds()`, which falls back to its default when the
 * CLI cannot be reached.
 *
 * The catalog spans several vendors (Antigravity also fronts Anthropic and
 * OpenAI models). This is the *Gemini* provider, so only Google-served entries
 * are offered; surfacing the others here would put the same model behind two
 * unrelated Nimbalyst providers with different billing stories.
 */

import type { AntigravityModelInfo, AntigravityServerManager } from './AntigravityServerManager';

/** `apiProvider` value the language server reports for Google-served models. */
const GOOGLE_API_PROVIDER = 'API_PROVIDER_GOOGLE_GEMINI';

/**
 * Oldest Flash generation still offered in the picker, as `[major, minor]`.
 *
 * The backend retires Flash generations well before the language server stops
 * listing them: `gemini-3-flash-agent` is still in `GetAvailableModels` (as
 * "Gemini 3.5 Flash (High)") on Antigravity 2.12.2, but a turn against it now
 * fails with "Gemini 3.5 Flash is no longer available. Please switch to Gemini
 * 3.7 Flash in the latest version of Antigravity." -- #1519. Entitlement does
 * not catch this either; the account is still entitled to a model the backend
 * refuses to serve. So the catalog alone cannot be trusted and the floor has
 * to be explicit.
 *
 * A floor rather than a fixed list so the next generation is picked up without
 * a code change: when 3.9 Flash lands, discovery offers it and only the
 * retired tiers stay hidden.
 */
const MIN_FLASH_GENERATION: readonly [major: number, minor: number] = [3, 7];

/**
 * Matches the Flash agent labels and nothing else.
 *
 * Anchored on both ends deliberately. The catalog also carries "Gemini 3.5
 * Flash Lite" and "Gemini 3.1 Flash Image", which are different products that
 * happen to share the prefix -- an unanchored match would drag them in.
 */
const FLASH_LABEL = /^Gemini (\d+)(?:\.(\d+))? Flash(?: \((?:High|Medium|Low)\))?$/;

/**
 * Generation of a Flash agent label as `[major, minor]`, or null when the
 * label is not a Flash agent at all.
 */
function flashGeneration(displayName: string): [number, number] | null {
  const match = FLASH_LABEL.exec(displayName);
  if (!match) return null;
  return [Number(match[1]), match[2] === undefined ? 0 : Number(match[2])];
}

/**
 * True when `displayName` is a Flash agent at or above `MIN_FLASH_GENERATION`.
 *
 * Compared component-wise rather than as a decimal so a future "Gemini 3.10
 * Flash" sorts after 3.9 instead of before 3.2.
 */
export function isOfferedFlashModel(displayName: string): boolean {
  const generation = flashGeneration(displayName);
  if (!generation) return false;
  const [major, minor] = generation;
  const [minMajor, minMinor] = MIN_FLASH_GENERATION;
  return major !== minMajor ? major > minMajor : minor >= minMinor;
}

/**
 * Fallback catalog, used only until the language server has been reached once.
 *
 * Seeded with 3.7 rather than the newer 3.8 on purpose: this list is what a
 * user sees before discovery has run, so it has to be a generation every
 * entitled account can actually serve, and 3.7 Flash is the one the backend
 * itself names in the #1519 error. Discovery adds 3.8 as soon as the server is
 * reachable.
 */
export const SEED_GEMINI_MODELS: ReadonlyArray<{ key: string; displayName: string }> =
  Object.freeze([
    { key: 'gemini-3.7-flash-high', displayName: 'Gemini 3.7 Flash (High)' },
    { key: 'gemini-3.7-flash-low', displayName: 'Gemini 3.7 Flash (Low)' },
    { key: 'gemini-3.7-flash-medium', displayName: 'Gemini 3.7 Flash (Medium)' },
  ]);

/** Default model key for a new Gemini session. */
export const DEFAULT_GEMINI_MODEL_KEY = 'gemini-3.7-flash-medium';

/**
 * Strip the `antigravity-gemini-agent:` namespace off a stored model id.
 *
 * The host persists the namespaced form; the language server only knows the
 * bare key. Callers may hand us either.
 */
export function bareGeminiModelKey(raw: string | undefined | null): string {
  if (!raw) return DEFAULT_GEMINI_MODEL_KEY;
  return raw.includes(':') ? raw.split(':').slice(1).join(':') : raw;
}

/**
 * Google-served models the signed-in account may use, newest-looking first.
 *
 * `entitledEnums` is the set of model enums from `clientModelConfigs`. It is
 * the account's entitlement, not the build's catalog: a model present in
 * `GetAvailableModels` but absent here will fail at request time, so offering
 * it would only produce a confusing error after the user picked it. When the
 * entitlement set is empty (an older server that does not report it) the
 * catalog is used unfiltered rather than showing nothing.
 *
 * Also restricted to Flash agents at or above `MIN_FLASH_GENERATION`. Retired
 * tiers stay in the live catalog and stay entitled long after the backend
 * stops serving them, so neither signal can be relied on -- see #1519.
 *
 * Existing sessions are not rewritten. A session row that persisted a retired
 * key keeps resolving, because resolution reads the stored key and never
 * consults this list; such a session will keep failing at request time until
 * the user picks a current model.
 */
export function selectGeminiModels(
  catalog: Map<string, AntigravityModelInfo>,
  entitledEnums: ReadonlySet<string>,
): Array<{ key: string; displayName: string }> {
  const out: Array<{ key: string; displayName: string }> = [];
  for (const info of catalog.values()) {
    if (info.apiProvider !== GOOGLE_API_PROVIDER) continue;
    if (entitledEnums.size > 0 && !entitledEnums.has(info.enum)) continue;
    // An unlabelled entry is an internal/experimental slot (the server returns
    // several with no displayName). Nothing useful to show the user.
    if (!info.displayName) continue;
    if (!isOfferedFlashModel(info.displayName)) continue;
    out.push({ key: info.key, displayName: info.displayName });
  }
  return out.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/** Read the account's entitled model enums out of a raw GetUserStatus payload. */
export function entitledModelEnums(userStatus: unknown): Set<string> {
  const enums = new Set<string>();
  const configs = (userStatus as {
    cascadeModelConfigData?: { clientModelConfigs?: Array<{ modelOrAlias?: { model?: unknown } }> };
  } | null | undefined)?.cascadeModelConfigData?.clientModelConfigs;
  if (!Array.isArray(configs)) return enums;
  for (const config of configs) {
    const name = config?.modelOrAlias?.model;
    if (typeof name === 'string' && name) enums.add(name);
  }
  return enums;
}

/**
 * Discover the model list, falling back to the seed when the server is not
 * already running or either RPC fails.
 */
export async function discoverGeminiModels(
  server: AntigravityServerManager,
): Promise<Array<{ key: string; displayName: string }>> {
  const endpoint = server.currentEndpoint();
  if (!endpoint) return [...SEED_GEMINI_MODELS];
  try {
    const [catalog, userStatus] = await Promise.all([
      server.getAvailableModels(endpoint),
      server.getUserStatus(endpoint).catch(() => null),
    ]);
    const models = selectGeminiModels(catalog, entitledModelEnums(userStatus));
    return models.length > 0 ? models : [...SEED_GEMINI_MODELS];
  } catch {
    return [...SEED_GEMINI_MODELS];
  }
}
