/**
 * WalkthroughService - Client-side service for walkthrough state management
 *
 * Handles IPC communication with main process for persisting walkthrough state.
 */

import type { WalkthroughState, WalkthroughStep, WalkthroughDefinition } from './types';

/**
 * Get the current walkthrough state from main process
 */
export async function getWalkthroughState(): Promise<WalkthroughState> {
  return window.electronAPI.invoke('walkthroughs:get-state');
}

/**
 * Enable or disable walkthroughs globally
 */
export async function setWalkthroughsEnabled(enabled: boolean): Promise<void> {
  return window.electronAPI.invoke('walkthroughs:set-enabled', enabled);
}

/**
 * Mark a walkthrough as completed
 */
export async function markWalkthroughCompleted(
  walkthroughId: string,
  version?: number
): Promise<void> {
  return window.electronAPI.invoke('walkthroughs:mark-completed', walkthroughId, version);
}

/**
 * Mark a walkthrough as dismissed
 */
export async function markWalkthroughDismissed(
  walkthroughId: string,
  version?: number
): Promise<void> {
  return window.electronAPI.invoke('walkthroughs:mark-dismissed', walkthroughId, version);
}

/**
 * Record that a walkthrough was shown (for analytics)
 * Also updates the per-mode cooldown timestamp
 */
export async function recordWalkthroughShown(
  walkthroughId: string,
  version?: number,
  mode?: 'files' | 'agent'
): Promise<void> {
  return window.electronAPI.invoke('walkthroughs:record-shown', walkthroughId, version, mode);
}

/**
 * Reset all walkthrough state (for testing)
 */
export async function resetWalkthroughState(): Promise<void> {
  return window.electronAPI.invoke('walkthroughs:reset');
}

/**
 * Register walkthrough metadata with main process for dynamic menu generation.
 * Should be called once when the renderer initializes.
 */
export async function registerWalkthroughMenuEntries(
  walkthroughs: Array<{ id: string; name: string }>
): Promise<void> {
  return window.electronAPI.invoke('walkthroughs:register-menu-entries', walkthroughs);
}

const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Check if a walkthrough should be shown based on current state
 */
export function shouldShowWalkthrough(
  state: WalkthroughState,
  walkthrough: WalkthroughDefinition,
  currentMode?: 'files' | 'agent'
): boolean {
  // Globally disabled
  if (!state.enabled) return false;

  // Newer versions should re-show even if the previous version was dismissed
  // or completed. History tracks the last version the user saw.
  if (walkthrough.version !== undefined) {
    const history = state.history?.[walkthrough.id];
    if (history?.version !== undefined && history.version !== walkthrough.version) {
      return true;
    }
  }

  // Already completed or dismissed
  if (state.completed.includes(walkthrough.id)) return false;
  if (state.dismissed.includes(walkthrough.id)) return false;

  // Check per-mode cooldown (prevents rapid-fire walkthroughs in same mode)
  if (currentMode && state.lastShownAtByMode?.[currentMode]) {
    const lastShown = state.lastShownAtByMode[currentMode];
    const timeSinceLastShown = Date.now() - lastShown;
    if (timeSinceLastShown < COOLDOWN_MS) {
      if (import.meta.env.DEV) {
        console.log(`[Walkthrough] Cooldown active for ${currentMode} mode (${Math.floor((COOLDOWN_MS - timeSinceLastShown) / 1000)}s remaining)`);
      }
      return false;
    }
  }

  return true;
}

/**
 * Resolve target element from a WalkthroughStep target specification.
 * Prefers data-testid, falls back to selector.
 * Only returns elements that are actually visible (not in hidden panels).
 */
export function resolveTarget(target: WalkthroughStep['target']): HTMLElement | null {
  let element: HTMLElement | null = null;

  // Try testId first (preferred)
  if (target.testId) {
    // Find all matching elements and return the first visible one
    const elements = document.querySelectorAll(`[data-testid="${target.testId}"]`);
    for (const el of elements) {
      if (isTargetValid(el as HTMLElement)) {
        element = el as HTMLElement;
        break;
      }
    }
  }

  // Fall back to selector
  if (!element && target.selector) {
    const elements = document.querySelectorAll(target.selector);
    for (const el of elements) {
      if (isTargetValid(el as HTMLElement)) {
        element = el as HTMLElement;
        break;
      }
    }
  }

  return element;
}

/**
 * Check if a target element is valid (visible and in viewport)
 */
export function isTargetValid(element: HTMLElement): boolean {
  // 1. Check element exists in DOM
  if (!document.body.contains(element)) return false;

  // 2. Check not hidden via display/visibility
  const style = getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden') return false;

  // 3. Check element has dimensions (not zero-sized)
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;

  // 4. Check element is not clipped by ancestors with display:none
  let parent = element.parentElement;
  while (parent && parent !== document.body) {
    const parentStyle = getComputedStyle(parent);
    if (parentStyle.display === 'none') return false;
    parent = parent.parentElement;
  }

  // 5. Check element is at least partially in viewport
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const isInViewport =
    rect.top < viewportHeight &&
    rect.bottom > 0 &&
    rect.left < viewportWidth &&
    rect.right > 0;

  return isInViewport;
}

/**
 * Check if any modal/overlay is currently visible in the DOM.
 * This catches dialogs that aren't managed by DialogProvider.
 */
export function hasVisibleOverlay(): boolean {
  // Check for elements with the nim-overlay class (common pattern for modals)
  const overlays = document.querySelectorAll('.nim-overlay');
  for (const overlay of overlays) {
    if (isTargetValid(overlay as HTMLElement)) {
      return true;
    }
  }

  // Also check for common overlay patterns that might not use nim-overlay
  const otherOverlays = document.querySelectorAll(
    '.project-trust-toast-overlay, .welcome-modal-overlay, .onboarding-overlay, [class*="-overlay"][class*="fixed"]'
  );
  for (const overlay of otherOverlays) {
    if (isTargetValid(overlay as HTMLElement)) {
      return true;
    }
  }

  return false;
}

/**
 * Calculate callout position relative to target element.
 * Returns absolute coordinates for positioning.
 */
export interface CalloutPosition {
  top: number;
  left: number;
  arrowPosition: 'top' | 'bottom' | 'left' | 'right';
  /** Offset in pixels for arrow positioning from edge of callout */
  arrowOffset: number;
}

const CALLOUT_WIDTH = 320;
/**
 * Width of the wide variant. Must match the `w-[420px]` Tailwind class applied
 * in `WalkthroughCallout.tsx` when `step.wide` is true. If you change one, change
 * both. Otherwise viewport-clamp arithmetic here disagrees with the rendered
 * width and the callout will overflow the viewport edge on wide steps.
 */
const CALLOUT_WIDE_WIDTH = 420;
const CALLOUT_HEIGHT_ESTIMATE = 200; // Will vary based on content
const ARROW_SIZE = 12;
const VIEWPORT_MARGIN = 16;
const ARROW_MIN_OFFSET = 24; // Minimum distance from edge for arrow
const ARROW_MAX_OFFSET_FROM_EDGE = 24; // Maximum distance arrow can be from callout edge

export function calculateCalloutPosition(
  target: HTMLElement,
  preferredPlacement: WalkthroughStep['placement'],
  wide: boolean = false,
): CalloutPosition {
  const calloutWidth = wide ? CALLOUT_WIDE_WIDTH : CALLOUT_WIDTH;
  const rect = target.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  // Center of target element
  const targetCenterX = rect.left + rect.width / 2;
  const targetCenterY = rect.top + rect.height / 2;

  // Calculate available space in each direction
  const spaceAbove = rect.top;
  const spaceBelow = viewportHeight - rect.bottom;
  const spaceLeft = rect.left;
  const spaceRight = viewportWidth - rect.right;

  // Determine best placement - always use auto logic to ensure it fits
  let placement = preferredPlacement;

  // Check if preferred placement actually fits, otherwise find the best alternative
  const fitsRight = spaceRight >= calloutWidth + ARROW_SIZE + VIEWPORT_MARGIN;
  const fitsLeft = spaceLeft >= calloutWidth + ARROW_SIZE + VIEWPORT_MARGIN;
  const fitsBelow = spaceBelow >= CALLOUT_HEIGHT_ESTIMATE + ARROW_SIZE + VIEWPORT_MARGIN;
  const fitsAbove = spaceAbove >= CALLOUT_HEIGHT_ESTIMATE + ARROW_SIZE + VIEWPORT_MARGIN;

  if (placement === 'auto' ||
      (placement === 'right' && !fitsRight) ||
      (placement === 'left' && !fitsLeft) ||
      (placement === 'bottom' && !fitsBelow) ||
      (placement === 'top' && !fitsAbove)) {
    // Find the best placement based on available space
    // Priority: bottom > right > top > left (most natural reading flow)
    if (fitsBelow) {
      placement = 'bottom';
    } else if (fitsRight) {
      placement = 'right';
    } else if (fitsAbove) {
      placement = 'top';
    } else if (fitsLeft) {
      placement = 'left';
    } else {
      // Nothing fits perfectly - choose the side with most space
      const spaces = [
        { placement: 'bottom' as const, space: spaceBelow },
        { placement: 'right' as const, space: spaceRight },
        { placement: 'top' as const, space: spaceAbove },
        { placement: 'left' as const, space: spaceLeft },
      ];
      spaces.sort((a, b) => b.space - a.space);
      placement = spaces[0].placement;
    }
  }

  let top: number;
  let left: number;
  let arrowPosition: 'top' | 'bottom' | 'left' | 'right';

  switch (placement) {
    case 'top':
      top = rect.top - CALLOUT_HEIGHT_ESTIMATE - ARROW_SIZE;
      left = targetCenterX - calloutWidth / 2;
      arrowPosition = 'bottom';
      break;
    case 'bottom':
      top = rect.bottom + ARROW_SIZE;
      left = targetCenterX - calloutWidth / 2;
      arrowPosition = 'top';
      break;
    case 'left':
      top = targetCenterY - CALLOUT_HEIGHT_ESTIMATE / 2;
      left = rect.left - calloutWidth - ARROW_SIZE;
      arrowPosition = 'right';
      break;
    case 'right':
      top = targetCenterY - CALLOUT_HEIGHT_ESTIMATE / 2;
      left = rect.right + ARROW_SIZE;
      arrowPosition = 'left';
      break;
    default:
      // Fallback to bottom
      top = rect.bottom + ARROW_SIZE;
      left = targetCenterX - calloutWidth / 2;
      arrowPosition = 'top';
  }

  // Clamp to viewport bounds
  left = Math.max(VIEWPORT_MARGIN, Math.min(left, viewportWidth - calloutWidth - VIEWPORT_MARGIN));
  top = Math.max(VIEWPORT_MARGIN, Math.min(top, viewportHeight - CALLOUT_HEIGHT_ESTIMATE - VIEWPORT_MARGIN));

  // Calculate arrow offset - where the arrow should point to hit the target
  let arrowOffset: number;

  if (arrowPosition === 'left' || arrowPosition === 'right') {
    // Arrow should point at target center vertically
    arrowOffset = targetCenterY - top;
    // Clamp arrow to stay within callout bounds with padding
    arrowOffset = Math.max(ARROW_MIN_OFFSET, Math.min(arrowOffset, CALLOUT_HEIGHT_ESTIMATE - ARROW_MIN_OFFSET));
  } else {
    // Arrow should point at target center horizontally
    arrowOffset = targetCenterX - left;
    // Clamp arrow to stay within callout bounds with padding
    arrowOffset = Math.max(ARROW_MIN_OFFSET, Math.min(arrowOffset, calloutWidth - ARROW_MIN_OFFSET));
  }

  return { top, left, arrowPosition, arrowOffset };
}
