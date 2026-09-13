import { spawnSync } from 'node:child_process';
import { tasks } from './validation-inventory.mjs';
import { npmSpawnConfig } from './run-workspace-script.mjs';

if (process.argv.length < 3) throw new Error('Specify a validation task');
for (const name of process.argv.slice(2)) {
  if (!tasks[name]) throw new Error(`Unknown validation task: ${name}`);
  for (const [tool, ...args] of tasks[name]) {
    const launch = tool === 'npm' ? npmSpawnConfig() : { command: process.execPath, argsPrefix: [] };
    console.log(`[validation] ${name}: ${tool} ${args.join(' ')}`);
    const result = spawnSync(launch.command, [...launch.argsPrefix, ...args], { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
