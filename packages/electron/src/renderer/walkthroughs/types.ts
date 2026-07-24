/**
 * Type definitions for the Walkthrough Guide System
 *
 * Walkthroughs are declarative multi-step guides that help users
 * discover features and learn the product.
 */

/**
 * Content mode in the app - imported from shared types
 */
import type { ContentMode as ContentModeType } from '../types/WindowModeTypes';
export type ContentMode = ContentModeType;

/**
 * Target element specification for a walkthrough step.
 * Prefer data-testid for stability across refactors.
 */
export interface WalkthroughTarget {
  /** Primary: use data-testid attribute (preferred for stability) */
  testId?: string;
  /** Fallback: CSS selector (use sparingly) */
  selector?: string;
}

/**
 * Optional action button for a walkthrough step
 */
export interface WalkthroughAction {
  /** Button label text */
  label: string;
  /** Callback when button is clicked */
  onClick: () => void;
}

/**
 * A single step in a walkthrough sequence
 */
export interface WalkthroughStep {
  /** Unique identifier for this step */
  id: string;
  /** Target element to attach the callout to */
  target: WalkthroughTarget;
  /**
   * Additional visibility condition for this step.
   * Return false to skip this step or wait for the condition to be met.
   * Useful for conditional UI elements like diff headers.
   */
  visibilityCondition?: () => boolean;
  /** Step title */
  title: string;
  /**
   * Step body text. Supports basic markdown:
   * - **bold** text
   * - Line breaks (blank lines become paragraphs)
   * - Bullet lists (lines starting with - or *)
   */
  body: string;
  /**
   * Optional keyboard shortcut to display.
   * Use a shortcut string from KeyboardShortcuts (e.g., 'Cmd+O').
   * Will be converted to platform-appropriate symbols automatically.
   */
  shortcut?: string;
  /** Preferred callout placement relative to target */
  placement: 'top' | 'bottom' | 'left' | 'right' | 'auto';
  /** Optional action button (e.g., "Try it now") */
  action?: WalkthroughAction;
  /**
   * Use a wider callout for content-heavy steps.
   * Default callout is 320px wide; wide mode is 420px.
   */
  wide?: boolean;
}

/**
 * Trigger conditions for when to show a walkthrough
 */
export interface WalkthroughTrigger {
  /**
   * Screen/mode that must be active.
   * Use '*' to match any screen.
   */
  screen?: ContentMode | 'workspace-manager' | '*';
  /**
   * Custom predicate for more complex conditions.
   * e.g., check if diff mode is active, if a specific panel is open, etc.
   */
  condition?: () => boolean;
  /**
   * Delay in milliseconds before showing after trigger conditions are met.
   * Useful to let UI settle after navigation.
   */
  delay?: number;
  /**
   * Priority for deconfliction when multiple walkthroughs are eligible.
   * Higher values = higher priority.
   */
  priority?: number;
}

/**
 * Complete walkthrough definition
 */
export interface WalkthroughDefinition {
  /** Unique identifier for this walkthrough */
  id: string;
  /** Human-readable name (for analytics) */
  name: string;
  /** Trigger conditions */
  trigger: WalkthroughTrigger;
  /** Sequential steps */
  steps: WalkthroughStep[];
  /**
   * Version number for re-showing updated walkthroughs.
   * If version changes, users who completed an older version will see it again.
   */
  version?: number;
}

/**
 * Walkthrough state from main process store
 */
export interface WalkthroughState {
  /** Master toggle for all walkthroughs */
  enabled: boolean;
  /** Walkthrough IDs that were completed */
  completed: string[];
  /** Walkthrough IDs that were dismissed */
  dismissed: string[];
  /** History of walkthrough interactions */
  history?: Record<string, WalkthroughHistory>;
  /** Per-mode timestamps for cooldown tracking (5 min between walkthroughs per mode) */
  lastShownAtByMode?: {
    files?: number;
    agent?: number;
  };
}

/**
 * History entry for a walkthrough
 */
export interface WalkthroughHistory {
  /** Timestamp when walkthrough was first shown */
  shownAt: number;
  /** Timestamp when completed (if applicable) */
  completedAt?: number;
  /** Timestamp when dismissed (if applicable) */
  dismissedAt?: number;
  /** Version that was shown */
  version?: number;
}

/**
 * Context value for the walkthrough provider
 */
export interface WalkthroughContextValue {
  /** Current walkthrough state from store */
  state: WalkthroughState | null;
  /** ID of the currently active walkthrough (if any) */
  activeWalkthroughId: string | null;
  /** Current step index in the active walkthrough */
  currentStepIndex: number;
  /** Start a specific walkthrough */
  startWalkthrough: (walkthroughId: string) => void;
  /** Dismiss the current walkthrough */
  dismissWalkthrough: () => void;
  /** Complete the current walkthrough (finished all steps) */
  completeWalkthrough: () => void;
  /** Go to next step */
  nextStep: () => void;
  /** Go to previous step */
  previousStep: () => void;
  /** Enable/disable walkthroughs globally */
  setEnabled: (enabled: boolean) => void;
}
