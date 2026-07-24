/**
 * Preserves the editor's range selection when focus is restored via Tab.
 * Without this, tabbing back into the editor collapses the selection to
 * the caret.
 *
 * Headless extension (Phase 7.3). Replaces the prior React-component
 * `TabFocusPlugin` mounted in Editor.tsx.
 */

import {
  $getSelection,
  $isRangeSelection,
  $setSelection,
  COMMAND_PRIORITY_LOW,
  FOCUS_COMMAND,
  defineExtension,
} from 'lexical';

const TAB_TO_FOCUS_INTERVAL = 100;

let lastTabKeyDownTimestamp = 0;
let hasRegisteredKeyDownListener = false;

function registerKeyTimeStampTracker(): void {
  window.addEventListener(
    'keydown',
    (event: KeyboardEvent) => {
      if (event.key === 'Tab') {
        lastTabKeyDownTimestamp = event.timeStamp;
      }
    },
    true,
  );
}

export const TabFocusExtension = defineExtension({
  name: '@nimbalyst/editor/tab-focus',
  register: (editor) => {
    if (!hasRegisteredKeyDownListener) {
      registerKeyTimeStampTracker();
      hasRegisteredKeyDownListener = true;
    }
    return editor.registerCommand(
      FOCUS_COMMAND,
      (event: FocusEvent) => {
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          if (
            lastTabKeyDownTimestamp + TAB_TO_FOCUS_INTERVAL >
            event.timeStamp
          ) {
            $setSelection(selection.clone());
          }
        }
        return false;
      },
      COMMAND_PRIORITY_LOW,
    );
  },
});
