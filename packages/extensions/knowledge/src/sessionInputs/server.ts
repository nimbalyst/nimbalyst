/**
 * `nimbalyst-session`: the nimbalyst-wiki plugin's local stdio MCP server.
 * One tool, `list_session_inputs`, lists what the person at this terminal
 * typed in the calling Claude Code session (prompts and question answers), so
 * a page can cite their words. It reads only the transcript it can prove is
 * the caller's (see claudeTranscriptLocator.ts), takes no path or session id
 * from the model, and sends nothing anywhere: the only text that leaves the
 * machine is a quote the agent decides to paste into a page.
 *
 * Bundled into plugins/nimbalyst-wiki/scripts/session-inputs.mjs by
 * scripts/build-wiki-plugin.mjs. Newline-delimited JSON-RPC on stdio, no SDK.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { citableInputsFromTranscript, selectInputs, type SessionInputKind } from './claudeTranscriptInputs';
import { locateTranscript, type LocatorDeps } from './claudeTranscriptLocator';

export const TOOL_NAME = 'list_session_inputs';
const SERVER_INFO = { name: 'nimbalyst-session', version: '0.2.0' };
const DEFAULT_PROTOCOL = '2025-06-18';

export const TOOL_DEFINITION = {
  name: TOOL_NAME,
  description:
    "List what the person at this terminal typed in this Claude Code session that a page may cite: their prompts and their answers to your questions. Each entry has a stable key, who, when, the quote and `citation`: ready markdown to paste right after the sentence it supports. Reads only this session's transcript on this machine; lists nothing when it cannot confirm which transcript is this session's. Pass the signed-in person's name and email from pages_status. Teammates' comments on pages come from list_citable_inputs instead.",
  inputSchema: {
    type: 'object',
    properties: {
      kinds: { type: 'array', items: { type: 'string', enum: ['prompt', 'answer'] }, description: 'Which inputs to list (default both).' },
      query: { type: 'string', description: 'Case-insensitive text to match in the quote or context.' },
      limit: { type: 'number', description: 'Maximum entries, newest kept (default 50, max 200).' },
      by: { type: 'string', description: "The person's display name, from pages_status `user`." },
      email: { type: 'string', description: "The person's email, from pages_status `user`." },
    },
  },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
};

export interface ServerDeps extends LocatorDeps {
  /** The git identity of the checkout, used when the call names nobody. */
  gitIdentity?: () => { name?: string; email?: string };
}

type JsonRpcId = string | number | null;
interface JsonRpcRequest {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: any;
}

function gitConfig(cwd: string | undefined, key: string): string | undefined {
  try {
    return execFileSync('git', ['config', '--get', key], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function textResult(value: unknown, isError = false) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}) };
}

const asString = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

export async function callListSessionInputs(params: any, deps: ServerDeps) {
  const args = params?.arguments ?? {};
  const toolUseId = asString(params?._meta?.['claudecode/toolUseId']);
  const located = await locateTranscript(toolUseId, deps);
  if (!located.ok) {
    return textResult({ inputs: [], notes: [located.reason, 'Nothing listed. Mark a decision with the signed-in person from pages_status instead of a quote.'] });
  }
  const git = deps.gitIdentity?.() ?? {};
  const by = asString(args.by) ?? git.name;
  const email = asString(args.email) ?? git.email;
  if (!by) return textResult({ inputs: [], notes: ['Pass `by` (and `email`) from pages_status `user`: the citations name the person.'] });
  const kinds = Array.isArray(args.kinds) ? args.kinds.filter((kind: unknown): kind is SessionInputKind => kind === 'prompt' || kind === 'answer') : undefined;
  const all = citableInputsFromTranscript(readFileSync(located.path, 'utf8'), { sessionId: located.sessionId, by, ...(email ? { email } : {}) });
  const inputs = selectInputs(all, { kinds, query: asString(args.query), limit: typeof args.limit === 'number' ? args.limit : undefined });
  const notes = inputs.length === 0 ? ['Nothing typed in this session matches.'] : [];
  return textResult({ inputs, notes });
}

/** One JSON-RPC message in, the response out (null for a notification). */
export async function handleMessage(message: JsonRpcRequest, deps: ServerDeps): Promise<object | null> {
  const id = message.id ?? null;
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id, result });
  if (message.id === undefined) return null;
  switch (message.method) {
    case 'initialize':
      return reply({
        protocolVersion: typeof message.params?.protocolVersion === 'string' ? message.params.protocolVersion : DEFAULT_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: [TOOL_DEFINITION] });
    case 'tools/call':
      if (message.params?.name !== TOOL_NAME) {
        return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${String(message.params?.name)}` } };
      }
      try {
        return reply(await callListSessionInputs(message.params, deps));
      } catch (err) {
        return reply(textResult({ inputs: [], notes: [`Could not read this session: ${err instanceof Error ? err.message : String(err)}`] }, true));
      }
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${String(message.method)}` } };
  }
}

function main(): void {
  const env = process.env;
  const deps: ServerDeps = {
    env: {
      CLAUDE_CODE_SESSION_ID: env.CLAUDE_CODE_SESSION_ID,
      CLAUDE_PROJECT_DIR: env.CLAUDE_PROJECT_DIR,
      CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR,
      HOME: env.HOME,
    },
    gitIdentity: () => ({ name: gitConfig(env.CLAUDE_PROJECT_DIR, 'user.name'), email: gitConfig(env.CLAUDE_PROJECT_DIR, 'user.email') }),
  };
  const lines = createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    if (!line.trim()) return;
    let message: JsonRpcRequest;
    try {
      message = JSON.parse(line);
    } catch {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`);
      return;
    }
    void handleMessage(message, deps).then((response) => {
      if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
