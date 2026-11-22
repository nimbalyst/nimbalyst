/**
 * Detect the models a signed-in Claude account can use.
 *
 * The Claude Agent SDK only lists the short aliases (opus, sonnet, fable, haiku), so a
 * model such as Claude Mythos never shows up on its own. When the user clicks "Detect
 * account models", this module asks Anthropic's `/v1/models` list, keeps the models the
 * built-in rows do not cover, and hands them to the picker as custom model options
 * (`claude-code:custom/<id>`). Nothing here runs at start-up or on a timer.
 *
 * The sign-in token is used only for the one request. It is never logged, returned or saved.
 */

import { z } from 'zod';
import {
  type ClaudeCustomModelOption,
  type ClaudeModelPickerConfig,
} from '@nimbalyst/runtime/ai/claudeCustomModels';
import { CLAUDE_CODE_PINNED_SDK_MODELS, type ClaudeCodeVariant } from '@nimbalyst/runtime/ai/modelConstants';
import { logger } from '../../utils/logger';

const MODELS_URL = 'https://api.anthropic.com/v1/models?limit=1000';
const REQUEST_TIMEOUT_MS = 15_000;

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

/** Thrown when the account model list cannot be read. */
export class AccountModelsError extends Error {
  constructor(public readonly code: AccountModelsErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'AccountModelsError';
  }
}

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
  /** The list saved by the last run. Used only to tell which models are new. Defaults to empty. */
  getSaved?: () => ClaudeCustomModelOption[];
}

// Unknown keys pass through. A field with the wrong type fails the row, and the row is skipped.
const AccountModelRowSchema = z.looseObject({
  id: z.string().min(1),
  display_name: z.string().optional(),
  line: z.string().optional(),
  max_input_tokens: z.number().optional(),
  lifecycle: z.string().optional(),
});

const AccountModelsResponseSchema = z.looseObject({ data: z.array(z.unknown()) });

/**
 * Read the `/v1/models` answer. Rows that do not fit the shape are skipped.
 * Throws `AccountModelsError('bad-response')` when `data` is missing.
 */
export function parseAccountModelsResponse(json: unknown): AccountModel[] {
  const envelope = AccountModelsResponseSchema.safeParse(json);
  if (!envelope.success) throw new AccountModelsError('bad-response');

  const models: AccountModel[] = [];
  for (const raw of envelope.data.data) {
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
 * Ask Anthropic which models the signed-in account can use and save the ones the built-in
 * list lacks. `save` and `clearModelCache` run only when the whole run succeeded, so a
 * failed run never wipes a list saved earlier.
 */
export async function detectAccountModels(deps: DetectAccountModelsDeps): Promise<DetectAccountModelsResult> {
  const token = await deps.getToken();
  if (!token) return failure('not-signed-in');

  let response: Response;
  try {
    response = await deps.fetchImpl(MODELS_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'anthropic-version': '2023-06-01',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    // Log the error name only: a message can quote the request, and the request holds the token.
    logger.main.warn(`[claudeAccountModels] Request failed (${error instanceof Error ? error.name : 'unknown error'})`);
    return failure('network');
  }

  if (!response.ok) {
    // Log the status only, never the body, the request or the headers.
    logger.main.warn(`[claudeAccountModels] Models request returned HTTP ${response.status}`);
    if (response.status === 401 || response.status === 403) return failure('sign-in-expired');
    return failure('network');
  }

  let models: AccountModel[];
  try {
    models = parseAccountModelsResponse(await response.json());
  } catch (error) {
    logger.main.warn(`[claudeAccountModels] Could not read the models answer (${error instanceof Error ? error.name : 'unknown error'})`);
    return failure('bad-response');
  }

  // An account always has models. An empty list means the answer is wrong, and saving it
  // would wipe the models found earlier.
  if (models.length === 0) {
    logger.main.warn('[claudeAccountModels] The models answer held no readable models');
    return failure('bad-response');
  }

  const discovered = toDiscoveredOptions(models);
  const previous = new Set((deps.getSaved?.() ?? []).map((option) => option.model));
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
