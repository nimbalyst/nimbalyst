/**
 * Claude account models atom
 *
 * A counter that goes up each time main says the list of models for the signed-in Claude
 * account changed (after "Detect account models" succeeded). A component that shows the
 * model list, such as the chat model picker, reads the list again when this number changes.
 *
 * Updated by store/listeners/claudeAccountModelsListeners.ts.
 */

import { atom } from 'jotai';

export const claudeAccountModelsVersionAtom = atom(0);
