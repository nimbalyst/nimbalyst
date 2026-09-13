import { readFileSync, appendFileSync } from 'node:fs';
let log = '';
try { log = readFileSync(process.argv[2], 'utf8').replace(/\x1b\[[0-9;]*m/g, ''); } catch { /* Installation or build failed before Vitest. */ }
const summary = log.split('\n').filter(line => /^\s*(Test Files|Tests|Duration)\s/.test(line)).join('\n') || 'No Vitest summary emitted; inspect the failed or interrupted step.';
console.log(summary);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `summary<<VITEST_SUMMARY\n${summary}\nVITEST_SUMMARY\n`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Vitest\n\n\`\`\`text\n${summary}\n\`\`\`\n\nPhase totals are accumulated across workers, not CPU time.\n`);
