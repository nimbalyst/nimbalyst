/**
 * Detect the models a signed-in Claude account can use.
 *
 * The Claude Agent SDK only lists the short aliases (opus, sonnet, fable, haiku), so a
 * model such as Claude Mythos never shows up on its own. When the user clicks "Detect
 * account models", this module asks Anthropic's model list (through the Anthropic SDK),
 * keeps the models the built-in rows do not cover, and hands them to the picker as custom
 * model options (`claude-code:custom/<id>`). Nothing here runs at start-up or on a timer.
 *
 * The sign-in token is used only for the one request, and only to api.anthropic.com. It is
 * never logged, returned or saved.
 */

import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import {
  type ClaudeCustomModelOption,
  type ClaudeModelPickerConfig,
} from '@nimbalyst/runtime/ai/claudeCustomModels';
import { CLAUDE_CODE_PINNED_SDK_MODELS, type ClaudeCodeVariant } from '@nimbalyst/runtime/ai/modelConstants';
import { logger } from '../../utils/logger';

/** The beta flag Anthropic expects on a request that carries a Claude sign-in (OAuth) token. */
export const CLAUDE_OAUTH_BETA = 'oauth-2025-04-20';

const API_BASE_URL = 'https://api.anthropic.com';
const REQUEST_TIMEOUT_MS = 15_000;
/** Most rows read from the account list. Also the page size asked for. */
const MAX_ROWS = 1000;
const MAX_CONTEXT_WINDOW = 10_000_000;

/**
 * A model id is passed word for word to `claude --model <id>`. It may hold only letters,
 * digits, `.`, `_`, `-`, `[` and `]` (the last two for a name such as `opus[1m]`), and it may
 * not start with `-`, or the command would read it as an option.
 */
const MODEL_ID_PATTERN = /^(?!-)[A-Za-z0-9._[\]-]{1,128}$/;

/** Model lines that already map to a built-in variant. Any other line behaves like Opus. */
const KNOWN_LINES: readonly ClaudeCodeVariant[] = ['opus', 'sonnet', 'haiku', 'fable'];

/** Error codes the user can see, one per failure kind. */
export type AccountModelsErrorCode = 'not-signed-in' | 'sign-in-expired' | 'network' | 'bad-response';

/** The exact text the user reads for each error code. */
const ERROR_MESSAGES: Record<AccountModelsErrorCode, string> = {
  'not-signed-in': 'Sign in to Claude Code first.',
  'sign-in-expired': 'Claude sign-in expired. Run `claude` to sign in again.',
  network: 'Could not reach Anthropic. Check your connection and try again.',
  'bad-response': 'Anthropic sent an answer Nimbalyst could not read.',
};

/** One model row from the account list, with only the fields Nimbalyst uses. */
export type AccountModel = {
  id: string;
  displayName: string;
  line?: string;
  maxInputTokens?: number;
  lifecycle?: string;
};

/** Result sent back to the Settings screen. */
export type DetectAccountModelsResult =
  | { ok: true; added: { model: string; label: string }[]; totalFromAccount: number }
  | { ok: false; error: AccountModelsErrorCode; message: string };

/** Things the detection needs from the outside, so a test can replace each one. */
export interface DetectAccountModelsDeps {
  getToken: () => Promise<string | null>;
  fetchImpl: typeof fetch;
  save: (models: ClaudeCustomModelOption[]) => void;
  clearModelCache: () => void;
  /** The list saved by the last run. Used only to tell which models are new. */
  getSaved: () => ClaudeCustomModelOption[];
}

// The SDK checks the shape of the answer. It does not know the `line` and `lifecycle` fields,
// and it does not check the id, so this check covers those. Unknown keys pass through.
// A row that fails the check is skipped. A bad context window is dropped, and the row stays.
const AccountModelRowSchema = z.looseObject({
  id: z.string().regex(MODEL_ID_PATTERN),
  display_name: z.string().optional(),
  line: z.string().optional(),
  lifecycle: z.string().optional(),
  max_input_tokens: z.number().int().min(1).max(MAX_CONTEXT_WINDOW).optional().catch(undefined),
});

/** Read the rows of the account list. A row that does not fit the shape is skipped. */
export function parseAccountModelRows(rows: readonly unknown[]): AccountModel[] {
  const models: AccountModel[] = [];
  for (const raw of rows) {
    const row = AccountModelRowSchema.safeParse(raw);
    if (!row.success) continue;
    models.push({
      id: row.data.id,
      displayName: row.data.display_name ?? row.data.id,
      line: row.data.line,
      maxInputTokens: row.data.max_input_tokens,
      lifecycle: row.data.lifecycle,
    });
  }
  return models;
}

/**
 * Turn the account list into picker options. A model that already has a built-in row
 * (its id is a pinned SDK id) is dropped, and so is a retired model. The API order stays.
 *
 * A model on a line the app knows behaves like that line's current model. Any other line
 * (today: `mythos`) behaves like Opus, because on 2026-11-22 the Mythos `capabilities`
 * object was identical to the one for `claude-opus-5-5`.
 */
export function toDiscoveredOptions(models: AccountModel[]): ClaudeCustomModelOption[] {
  const builtInIds = new Set(Object.values(CLAUDE_CODE_PINNED_SDK_MODELS));
  const options: ClaudeCustomModelOption[] = [];
  for (const model of models) {
    if (builtInIds.has(model.id) || model.lifecycle === 'retired') continue;
    const lineVariant = KNOWN_LINES.find((variant) => variant === model.line);
    options.push({
      model: model.id,
      label: model.displayName,
      contextWindow: model.maxInputTokens,
      behavesAs: CLAUDE_CODE_PINNED_SDK_MODELS[lineVariant ?? 'opus'],
    });
  }
  return options;
}

/**
 * Put the options from Claude settings files first, then each discovered option the
 * settings do not already name. `replaceBuiltInOptions` comes from the settings files.
 */
export function mergePickerWithDiscovered(
  fromSettings: ClaudeModelPickerConfig,
  discovered: ClaudeCustomModelOption[],
): ClaudeModelPickerConfig {
  const named = new Set(fromSettings.options.map((option) => option.model));
  return {
    options: [...fromSettings.options, ...discovered.filter((option) => !named.has(option.model))],
    replaceBuiltInOptions: fromSettings.replaceBuiltInOptions,
  };
}

function failure(code: AccountModelsErrorCode): DetectAccountModelsResult {
  return { ok: false, error: code, message: ERROR_MESSAGES[code] };
}

/**
 * Turn an error from the SDK into the code the user sees and a line for the log.
 * The log line holds a status or an error name only. An SDK error message can quote the
 * answer, and the request holds the token.
 */
function describeFailure(error: unknown): { code: AccountModelsErrorCode; log: string } {
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return { code: 'sign-in-expired', log: `Models request returned HTTP ${error.status}` };
  }
  if (error instanceof Anthropic.APIConnectionError) {
    const kind = error instanceof Anthropic.APIConnectionTimeoutError ? 'APIConnectionTimeoutError' : 'APIConnectionError';
    const cause = (error as { cause?: unknown }).cause;
    return { code: 'network', log: `Request failed (${kind}, cause ${cause instanceof Error ? cause.name : 'unknown'})` };
  }
  if (error instanceof Anthropic.APIError) {
    return { code: 'network', log: `Models request returned HTTP ${error.status}` };
  }
  return {
    code: 'bad-response',
    log: `Could not read the models answer (${error instanceof Error ? error.name : 'unknown error'})`,
  };
}

/**
 * Read the account list from Anthropic. `for await` follows the list's pages. It stops at
 * `MAX_ROWS`, so an answer that keeps promising more pages cannot keep the loop running.
 */
async function readAccountModelRows(deps: DetectAccountModelsDeps, token: string): Promise<unknown[]> {
  const client = new Anthropic({
    // Fixed address. Without it the SDK would send the token to the ANTHROPIC_BASE_URL variable.
    baseURL: API_BASE_URL,
    authToken: token,
    // `null`, not left out: the SDK then sends no x-api-key and reads no ANTHROPIC_API_KEY variable.
    apiKey: null,
    defaultHeaders: { 'anthropic-beta': CLAUDE_OAUTH_BETA },
    timeout: REQUEST_TIMEOUT_MS,
    maxRetries: 0,
    // Refuse every redirect, so the token never goes to a second address.
    fetch: (input, init) => deps.fetchImpl(input, { ...init, redirect: 'error' }),
  });

  const rows: unknown[] = [];
  for await (const row of client.models.list({ limit: MAX_ROWS })) {
    rows.push(row);
    if (rows.length >= MAX_ROWS) break;
  }
  return rows;
}

/**
 * Ask Anthropic which models the signed-in account can use and save the ones the built-in
 * list lacks. `save` and `clearModelCache` run only when the whole run succeeded, so a
 * failed run never wipes a list saved earlier.
 */
export async function detectAccountModels(deps: DetectAccountModelsDeps): Promise<DetectAccountModelsResult> {
  const token = await deps.getToken();
  if (!token) return failure('not-signed-in');

  let models: AccountModel[];
  try {
    models = parseAccountModelRows(await readAccountModelRows(deps, token));
  } catch (error) {
    const { code, log } = describeFailure(error);
    logger.main.warn(`[claudeAccountModels] ${log}`);
    return failure(code);
  }

  // An account always has models. An empty list means the answer is wrong, and saving it
  // would wipe the models found earlier.
  if (models.length === 0) {
    logger.main.warn('[claudeAccountModels] The models answer held no readable models');
    return failure('bad-response');
  }

  const discovered = toDiscoveredOptions(models);
  const previous = new Set(deps.getSaved().map((option) => option.model));
  deps.save(discovered);
  deps.clearModelCache();
  return {
    ok: true,
    added: discovered
      .filter((option) => !previous.has(option.model))
      .map((option) => ({ model: option.model, label: option.label ?? option.model })),
    totalFromAccount: models.length,
  };
}
