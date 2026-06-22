/**
 * `nim status` — what am I connected to (live/direct), schema version, workspaces.
 */
import type { ParsedArgs } from '../cli/parse.js';
import { flagBool } from '../cli/parse.js';
import { makeGateway } from './common.js';
import { bold, dim, green, yellow } from '../cli/colors.js';

export async function runStatus(args: ParsedArgs): Promise<number> {
  const gateway = makeGateway(args);
  try {
    const status = await gateway.status();
    if (flagBool(args, 'json')) {
      process.stdout.write(JSON.stringify(status, null, 2) + '\n');
      return 0;
    }

    const modeLabel = status.mode === 'live' ? green('live (app running)') : yellow('direct (offline)');
    const lines: string[] = [];
    lines.push(`${bold('Mode')}     ${modeLabel}`);
    if (status.dbPath) lines.push(`${bold('Database')} ${status.dbPath}`);
    if (status.endpoint) {
      lines.push(`${bold('Endpoint')} 127.0.0.1:${status.endpoint.port} (pid ${status.endpoint.pid})`);
    }
    lines.push(`${bold('Schema')}   ${status.schemaVersion ?? dim('unknown')}`);
    if (status.workspaces && status.workspaces.length) {
      lines.push(`${bold('Workspaces')}`);
      for (const ws of status.workspaces) {
        lines.push(`  - ${ws.path}${ws.name ? `  ${dim(`(${ws.name})`)}` : ''}`);
      }
    } else {
      lines.push(`${bold('Workspaces')} ${dim('none discovered')}`);
    }
    process.stdout.write(lines.join('\n') + '\n');
    return 0;
  } finally {
    gateway.close();
  }
}
