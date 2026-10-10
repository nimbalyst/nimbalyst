/**
 * What every `nim wiki` subcommand shares: the resolved target, output, and
 * the tool call that stamps the target onto each Pages tool call.
 */
import type { ParsedArgs } from '../cli/parse.js';
import { ExitCode, usageError } from '../cli/exitCodes.js';
import { outputOptions } from './common.js';
import { callTool } from '../cloud/pagesClient.js';

export interface PagesCtx {
  args: ParsedArgs;
  server: string;
  /** Directory `.nimbalyst/wiki.json` lives in. */
  root: string;
  /** Arguments every tool call carries: `repo`, plus `project` when pinned. */
  base: Record<string, unknown>;
}

export function print(ctx: PagesCtx, value: unknown, human: () => string): number {
  const opts = outputOptions(ctx.args);
  const text = opts.json ? JSON.stringify(value, null, 2) : human();
  if (text) process.stdout.write(text + '\n');
  return ExitCode.OK;
}

export function operand(ctx: PagesCtx, index: number, what: string): string {
  const v = ctx.args.positionals[index];
  if (!v) throw usageError(`'nim wiki ${ctx.args.verb}' requires ${what}.`);
  return v;
}

/** Calls a Pages tool with the target's base arguments; undefined values are dropped. */
export function tool(ctx: PagesCtx, name: string, extra: Record<string, unknown> = {}, base = ctx.base): Promise<any> {
  const args: Record<string, unknown> = {};
  for (const [k, v] of Object.entries({ ...base, ...extra })) if (v !== undefined) args[k] = v;
  return callTool(ctx.server, name, args);
}
