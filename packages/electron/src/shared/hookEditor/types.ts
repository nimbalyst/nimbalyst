/**
 * Shared words for the hook editor's pure core. Nothing in this folder reads
 * files, opens windows or talks over IPC, so the main process and the screen
 * can both import it.
 */

/** Any value that JSON can hold. */
export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;

/** A JSON object: text keys, JSON values. */
export interface JsonObject {
  [key: string]: JsonValue;
}

/** True for a plain JSON object (not null, not a list). */
export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The five hook types that Claude Code runs. */
export type HookType = 'command' | 'http' | 'mcp_tool' | 'prompt' | 'agent';

export const HOOK_TYPES: readonly HookType[] = ['command', 'http', 'mcp_tool', 'prompt', 'agent'];

export function isHookType(value: unknown): value is HookType {
  return typeof value === 'string' && (HOOK_TYPES as readonly string[]).includes(value);
}

/** The six actions on the palette. Each one writes one hook type. */
export type ActionKind = 'runScript' | 'runCommand' | 'sendToWeb' | 'askAi' | 'runAgent' | 'callMcpTool';

/** What a Then block answers back to Claude Code. */
export type ThenAnswer = 'permission' | 'block' | 'addContext' | 'stopClaude' | 'tellUser' | 'watchFiles';

/** One Then block, as the user filled it in. */
export type ThenBlock =
  | { answer: 'permission'; decision: 'allow' | 'deny' | 'ask'; message: string }
  | { answer: 'block' | 'addContext' | 'stopClaude' | 'tellUser'; message: string }
  | { answer: 'watchFiles'; paths: string[] };

/**
 * Where the text came from. The three settings files, a hook pack draft, or a
 * read-only source (marketplace, managed policy, Nimbalyst built-in).
 */
export type HookSourceKind = 'userSettings' | 'projectSettings' | 'localSettings' | 'hookPackDraft' | 'readOnly';
