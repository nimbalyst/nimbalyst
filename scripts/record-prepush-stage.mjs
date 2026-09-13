import { readFileSync, writeFileSync } from 'node:fs';
const [stage, seconds, exitCode] = process.argv.slice(2);
const file = '.vitest/last-prepush.json';
const stages = JSON.parse(readFileSync(file, 'utf8'));
stages.push({ stage, seconds: Number(seconds), exitCode: Number(exitCode) });
writeFileSync(file, `${JSON.stringify(stages, null, 2)}\n`);
