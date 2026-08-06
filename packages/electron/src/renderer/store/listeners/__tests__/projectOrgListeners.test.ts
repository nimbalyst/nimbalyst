// @vitest-environment node
import { createStore } from 'jotai';
import { describe, expect, it, vi } from 'vitest';

import { projectOrgRevisionAtom } from '../../atoms/orgScope';
import { initProjectOrgListeners } from '../projectOrgListeners';

describe('initProjectOrgListeners', () => {
  it('re-resolves the project org for a window that did not run the wizard', () => {
    const jotaiStore = createStore();
    let broadcast: (() => void) | undefined;
    const unsubscribe = vi.fn();
    (globalThis as any).window = {
      electronAPI: {
        on: vi.fn((channel: string, listener: () => void) => {
          expect(channel).toBe('team:workspace-org-changed');
          broadcast = listener;
          return unsubscribe;
        }),
      },
    };

    const cleanup = initProjectOrgListeners(jotaiStore);
    const before = jotaiStore.get(projectOrgRevisionAtom);

    broadcast?.();

    expect(jotaiStore.get(projectOrgRevisionAtom)).toBe(before + 1);

    cleanup();
    expect(unsubscribe).toHaveBeenCalled();
  });
});
