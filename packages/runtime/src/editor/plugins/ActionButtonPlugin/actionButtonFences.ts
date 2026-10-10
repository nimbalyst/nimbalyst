/**
 * The fence names of the two action buttons. Separate from
 * `actionButtonSource.ts` so the headless node core does not load the YAML
 * parser.
 */

export const SESSION_ACTION_FENCE = 'action';
export const NEW_ITEM_ACTION_FENCE = 'new-item';

export type ActionButtonKind = 'session' | 'new-item';

export const ACTION_FENCE_BY_KIND: Record<ActionButtonKind, string> = {
  session: SESSION_ACTION_FENCE,
  'new-item': NEW_ITEM_ACTION_FENCE,
};
