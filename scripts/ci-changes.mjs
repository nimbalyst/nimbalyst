import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { classifyChanges } from './validation-inventory.mjs';
let selection = { docsOnly: false, sandbox: true };
try {
  const [base, head] = process.argv.slice(2);
  if (!/^[a-f0-9]{40}$/.test(base ?? '') || !/^[a-f0-9]{40}$/.test(head ?? '')) throw new Error('Missing commit identity');
  // --no-renames exposes both sides of renames. Unknown or deleted inputs take
  // the full path instead of relying on a filename-based absence heuristic.
  const changed = execFileSync('git', ['diff', '--name-status', '-z', '--no-renames', base, head], { encoding: 'utf8' }).split('\0');
  const files = [];
  for (let i = 0; i < changed.length - 1; i += 2) {
    if (!['A', 'M'].includes(changed[i])) throw new Error('Non-additive change');
    files.push(changed[i + 1]);
  }
  selection = classifyChanges(files);
} catch { /* Missing history or uncertain classifications run everything. */ }
console.log(JSON.stringify(selection));
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `docs-only=${selection.docsOnly}\nsandbox=${selection.sandbox}\n`);
