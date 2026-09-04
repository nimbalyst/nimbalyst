import { createCommand, type LexicalCommand } from 'lexical';
import type { DecisionPayload } from './DecisionNode';

/**
 * Programmatic insert.
 *
 * There is deliberately no slash-menu entry yet: authoring affordances (the
 * component picker, the toolbar, and the agent's draft-block path) are their
 * own slice, and shipping a menu item ahead of them would offer a block a user
 * cannot address to anyone.
 */
export const INSERT_DECISION_COMMAND: LexicalCommand<DecisionPayload> =
  createCommand('INSERT_DECISION_COMMAND');
