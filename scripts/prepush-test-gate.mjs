/**
 * The full Vitest suite is mandatory on every platform, including local Windows.
 */
export function shouldRunFullPrePushSuite({ platform = process.platform, ci = process.env.CI } = {}) {
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(shouldRunFullPrePushSuite() ? 'run\n' : 'skip\n');
}
import { pathToFileURL } from 'node:url';
