/**
 * Whether items of a tracker type get machine-private local numbers (`NIM.75`).
 *
 * On unless the type's YAML says `localNumbers: false`. It was briefly opt-in,
 * and because no type opted in, no new item got a number. A type the registry does not know yet (schemas still
 * loading at workspace open) counts as off: a missing number is filled in by
 * the next list pass, an unwanted one is never taken back. Numbers already
 * issued stay on their rows and keep resolving.
 */

import { globalRegistry } from '@nimbalyst/tracker-schema';

export function typeHasLocalNumbers(type: string | null | undefined): boolean {
  if (!type) return false;
  const model = globalRegistry.get(type);
  return model !== undefined && model.localNumbers !== false;
}
