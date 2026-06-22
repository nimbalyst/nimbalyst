#!/usr/bin/env node
/**
 * `nim` executable entry. Thin shim: slice argv, run, set the exit code.
 */
import { main } from '../index.js';

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`nim: fatal: ${err?.message ?? err}\n`);
    process.exitCode = 3;
  });
