/**
 * The full Vitest suite currently has Windows-nonportable failures. Keep it
 * mandatory everywhere else, including Windows CI, while local Windows pushes
 * retain the typecheck and focused-test gates.
 */
export function shouldRunFullPrePushSuite({ platform = process.platform, ci = process.env.CI } = {}) {
  return platform !== 'win32' || /^(1|true|yes)$/i.test(ci ?? '');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(shouldRunFullPrePushSuite() ? 'run\n' : 'skip\n');
}
import { pathToFileURL } from 'node:url';
