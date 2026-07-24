/**
 * `nim workspace <verb>` — list / show workspaces and current resolution.
 */
import type { ParsedArgs } from '../cli/parse.js';
import { flagStr, flagBool } from '../cli/parse.js';
import { usageError } from '../cli/exitCodes.js';
import { makeGateway } from './common.js';
import { resolveWorkspace } from '../workspace/resolve.js';
import { bold, dim } from '../cli/colors.js';

export async function runWorkspace(args: ParsedArgs): Promise<number> {
  const verb = args.verb ?? 'list';
  const gateway = makeGateway(args);
  try {
    if (verb === 'list') {
      const workspaces = await gateway.listWorkspaces();
      if (flagBool(args, 'json')) {
        process.stdout.write(JSON.stringify({ workspaces }, null, 2) + '\n');
        return 0;
      }
      if (flagBool(args, 'quiet')) {
        process.stdout.write(workspaces.map((w) => w.path).join('\n') + '\n');
        return 0;
      }
      if (workspaces.length === 0) {
        process.stdout.write(dim('No workspaces discovered.') + '\n');
        return 0;
      }
      const lines = workspaces.map((w) => `${w.path}${w.name ? `  ${dim(`(${w.name})`)}` : ''}`);
      process.stdout.write(lines.join('\n') + '\n');
      return 0;
    }

    if (verb === 'show' || verb === 'current') {
      const ws = await resolveWorkspace(gateway, flagStr(args, 'workspace'));
      if (flagBool(args, 'json')) {
        process.stdout.write(JSON.stringify({ workspace: ws }, null, 2) + '\n');
        return 0;
      }
      process.stdout.write(`${bold('Current workspace')} ${ws}\n`);
      return 0;
    }

    throw usageError(`Unknown workspace command '${verb}'. Try: list, show.`);
  } finally {
    gateway.close();
  }
}
