/**
 * Utility functions for generic typeahead functionality in textarea elements
 */

export interface TriggerMatch {
  trigger: string;
  query: string;
  startIndex: number;
  endIndex: number;
}

export type SlashTypeaheadScope = 'commands' | 'skills';

/**
 * Extract trigger match from text at cursor position
 * @param value Current textarea value
 * @param cursorPos Current cursor position
 * @param triggers Single trigger character or array of trigger characters (e.g., "@" or ["@", "/"])
 * @returns Match info or null if no match
 */
export function extractTriggerMatch(
  value: string,
  cursorPos: number,
  triggers: string | string[]
): TriggerMatch | null {
  // Normalize to array
  const triggerArray = Array.isArray(triggers) ? triggers : [triggers];

  // Get text before cursor
  const textBeforeCursor = value.substring(0, cursorPos);

  // Try each trigger and find the closest one to cursor
  let closestMatch: TriggerMatch | null = null;
  let closestDistance = Infinity;

  for (const trigger of triggerArray) {
    // Find last occurrence of trigger before cursor
    const lastTriggerIndex = textBeforeCursor.lastIndexOf(trigger);

    // Skip if trigger not found
    if (lastTriggerIndex === -1) {
      continue;
    }

    // Slash commands/skills can start at the beginning of the prompt or after whitespace.
    // This keeps `/skill-name` usable inside natural language prompts while avoiding
    // triggers inside words like "foo/bar".
    if (trigger === '/') {
      if (lastTriggerIndex > 0) {
        const charBeforeTrigger = textBeforeCursor[lastTriggerIndex - 1];
        if (!/\s/.test(charBeforeTrigger)) {
          continue;
        }
      }
    } else {
      // For other triggers (like @), check if at start or preceded by whitespace
      if (lastTriggerIndex > 0) {
        const charBeforeTrigger = textBeforeCursor[lastTriggerIndex - 1];
        if (!/\s/.test(charBeforeTrigger)) {
          // Trigger must be at start or after whitespace
          continue;
        }
      }
    }

    // Extract query from trigger to cursor
    const query = textBeforeCursor.substring(lastTriggerIndex + trigger.length);

    if (trigger === '/') {
      // Slash commands and skills are single tokens like /review or /my-skill.
      // Ignore path-like values (/Users/me) and stop once the user has typed args.
      if (query.includes('/') || /\s/.test(query)) {
        continue;
      }
    }

    // Query ends on:
    // - Double-space (intentional break)
    // - Newline
    // - "/ " (completed folder mention -- no filename starts with a space)
    // - ".ext " (completed file mention -- file extension followed by space)
    // Single spaces are otherwise allowed to support files with spaces in names.
    if (/\s{2}|[\n\r]|\/\s|\.[a-zA-Z0-9]+\s|\)\s/.test(query)) {
      continue;
    }

    // Check if this is the closest trigger to cursor
    const distance = cursorPos - lastTriggerIndex;
    if (distance < closestDistance) {
      closestDistance = distance;
      closestMatch = {
        trigger,
        query,
        startIndex: lastTriggerIndex,
        endIndex: cursorPos
      };
    }
  }

  return closestMatch;
}

/**
 * Slash completion offers the full command + skill list wherever a `/` trigger
 * is valid (column 0 or after whitespace). Built-in commands used to be hidden
 * once the cursor moved past column 0; they now appear mid-message too so the
 * menu is identical at the start of a prompt and inside it.
 */
export function getSlashTypeaheadScope(match: TriggerMatch | null): SlashTypeaheadScope | null {
  if (!match || match.trigger !== '/') {
    return null;
  }

  return 'commands';
}

/**
 * Insert text at cursor position, replacing the trigger match
 * @param value Current textarea value
 * @param match Trigger match to replace
 * @param text Text to insert
 * @returns New value and new cursor position
 */
export function insertAtTrigger(
  value: string,
  match: TriggerMatch,
  text: string
): { value: string; cursorPos: number } {
  const before = value.substring(0, match.startIndex);
  const after = value.substring(match.endIndex);
  const newValue = before + text + ' ' + after;
  const newCursorPos = before.length + text.length + 1; // +1 for the space

  return { value: newValue, cursorPos: newCursorPos };
}

/**
 * Get pixel coordinates of cursor position in textarea
 * Uses a mirror div technique to calculate position
 * @param textarea Textarea element
 * @param position Character position in text
 * @returns Coordinates relative to textarea
 */
export function getCursorCoordinates(
  textarea: HTMLTextAreaElement,
  position: number
): { top: number; left: number } {
  const computed = window.getComputedStyle(textarea);
  const mirror = document.createElement('div');

  // Copy styles to mirror
  const properties = [
    'boxSizing',
    'width',
    'height',
    'overflowX',
    'overflowY',
    'borderTopWidth',
    'borderRightWidth',
    'borderBottomWidth',
    'borderLeftWidth',
    'paddingTop',
    'paddingRight',
    'paddingBottom',
    'paddingLeft',
    'fontStyle',
    'fontVariant',
    'fontWeight',
    'fontStretch',
    'fontSize',
    'fontSizeAdjust',
    'lineHeight',
    'fontFamily',
    'textAlign',
    'textTransform',
    'textIndent',
    'textDecoration',
    'letterSpacing',
    'wordSpacing',
    'tabSize',
    'whiteSpace',
    'wordBreak',
    'wordWrap'
  ];

  properties.forEach(prop => {
    (mirror.style as any)[prop] = (computed as any)[prop];
  });

  // Position mirror off-screen
  mirror.style.position = 'absolute';
  mirror.style.top = '-9999px';
  mirror.style.left = '-9999px';
  mirror.style.overflow = 'hidden';
  mirror.style.visibility = 'hidden';
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.wordWrap = 'break-word';

  document.body.appendChild(mirror);

  try {
    const value = textarea.value;
    const textBeforeCursor = value.substring(0, position);
    const textAfterCursor = value.substring(position);

    // Create span for cursor position
    const cursorSpan = document.createElement('span');
    cursorSpan.textContent = '|';

    mirror.textContent = textBeforeCursor;
    mirror.appendChild(cursorSpan);
    mirror.appendChild(document.createTextNode(textAfterCursor));

    // Get the cursor position relative to the mirror div
    const cursorSpanRect = cursorSpan.getBoundingClientRect();
    const mirrorRect = mirror.getBoundingClientRect();

    // Calculate offset within the mirror (which matches textarea layout)
    const offsetTop = cursorSpanRect.top - mirrorRect.top;
    const offsetLeft = cursorSpanRect.left - mirrorRect.left;

    // Account for textarea scroll
    return {
      top: offsetTop + textarea.scrollTop,
      left: offsetLeft + textarea.scrollLeft
    };
  } finally {
    document.body.removeChild(mirror);
  }
}
