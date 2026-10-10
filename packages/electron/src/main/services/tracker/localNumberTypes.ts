/**
 * Whether items of a tracker type get machine-private local numbers (`NIM.75`).
 *
 * Off unless the type's YAML says `localNumbers: true`. A type the registry does
 * not know yet (schemas still loading at workspace open) counts as off: a
 * missing number is filled in by the next list pass, an unwanted one is never
 * taken back. Numbers already issued stay on their rows and keep resolving.
 */

import { globalRegistry } from '@nimbalyst/tracker-schema';

export function typeHasLocalNumbers(type: string | null | undefined): boolean {
  if (!type) return false;
  return globalRegistry.get(type)?.localNumbers === true;
}
