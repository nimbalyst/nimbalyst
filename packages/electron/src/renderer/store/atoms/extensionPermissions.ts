/**
 * Atoms for the extension privileged-capability surface.
 *
 * Per IPC_LISTENERS.md: components must never subscribe to IPC events
 * directly. The central listener in `extensionPermissionListeners.ts`
 * subscribes once, mutates these atoms, and components read from them.
 */
import { atom } from 'jotai';

/**
 * Queue of permission prompts the user has not yet resolved. The central
 * listener appends on `ext-permission-prompt:raise`, removes on
 * `ext-permission-prompt:resolved`, and seeds initial values via
 * `extPermissions.listPendingPrompts()` once at startup. Components show
 * `queue[0]` as the active modal.
 */
export const extensionPermissionPromptQueueAtom = atom<
  PermissionPromptRequestRow[]
>([]);

/**
 * Monotonic counter that ticks every time the privileged host emits a
 * state-changed event. Settings panels list `extensionPermissionHostStateVersionAtom`
 * in their `useEffect` deps so they re-query `listHostState()` etc. when
 * a module starts/stops/crashes.
 */
export const extensionPermissionHostStateVersionAtom = atom<number>(0);
