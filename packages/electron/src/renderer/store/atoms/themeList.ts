/**
 * Theme List Version Atom
 *
 * Counter incremented every time the main process emits `theme:list-changed`
 * (extension installs/uninstalls a theme, theme files reloaded, etc).
 * Components that render the theme list use this atom as a useEffect
 * dependency to re-fetch via `theme:list` invoke.
 *
 * Updated by store/listeners/themeListeners.ts. Consumers must follow the
 * "skip initial mount" idiom (capture the initial version in a ref and bail
 * out when it matches) so the side effect only runs on real bumps -- see
 * docs/IPC_LISTENERS.md.
 */

import { atom } from 'jotai';

export const themeListChangedVersionAtom = atom(0);
