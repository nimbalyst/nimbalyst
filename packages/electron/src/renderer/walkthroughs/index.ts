/**
 * Walkthrough Guide System
 *
 * A lightweight system for showing contextual callouts and multi-step guides
 * to help users discover features and learn the product.
 */

// Types
export type {
  WalkthroughStep,
  WalkthroughTarget,
  WalkthroughAction,
  WalkthroughTrigger,
  WalkthroughDefinition,
  WalkthroughState,
  WalkthroughHistory,
  WalkthroughContextValue,
  ContentMode,
} from './types';

// Components
export { WalkthroughCallout } from './components/WalkthroughCallout';
export { WalkthroughProvider, useWalkthrough, useWalkthroughSafe } from './components/WalkthroughProvider';

// Service
export {
  getWalkthroughState,
  setWalkthroughsEnabled,
  markWalkthroughCompleted,
  markWalkthroughDismissed,
  recordWalkthroughShown,
  resetWalkthroughState,
  shouldShowWalkthrough,
  resolveTarget,
  isTargetValid,
  calculateCalloutPosition,
} from './WalkthroughService';

// Definitions
export { walkthroughs } from './definitions';

// Jotai Atoms
export {
  walkthroughStateAtom,
  walkthroughsEnabledAtom,
  activeWalkthroughIdAtom,
  currentStepIndexAtom,
  isWalkthroughActiveAtom,
  completedWalkthroughsAtom,
  dismissedWalkthroughsAtom,
} from './atoms';
