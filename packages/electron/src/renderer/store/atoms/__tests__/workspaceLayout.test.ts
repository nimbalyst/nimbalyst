import { describe, it, expect, beforeEach } from 'vitest';
import { createStore } from 'jotai';
import {
  sidebarWidthAtomFamily,
  sidebarCollapsedAtomFamily,
  sidebarPreCollapseWidthAtomFamily,
  aiChatWidthAtomFamily,
  aiChatCollapsedAtomFamily,
} from '../workspaceLayout';

const PATH_A = '/ws/a';
const PATH_B = '/ws/b';

describe('workspaceLayout atom families', () => {
  let jotaiStore: ReturnType<typeof createStore>;

  beforeEach(() => {
    jotaiStore = createStore();
  });

  describe('isolation per workspace path', () => {
    it('sidebarWidth is independent per path', () => {
      jotaiStore.set(sidebarWidthAtomFamily(PATH_A), 320);
      jotaiStore.set(sidebarWidthAtomFamily(PATH_B), 480);

      expect(jotaiStore.get(sidebarWidthAtomFamily(PATH_A))).toBe(320);
      expect(jotaiStore.get(sidebarWidthAtomFamily(PATH_B))).toBe(480);
    });

    it('sidebarCollapsed is independent per path', () => {
      jotaiStore.set(sidebarCollapsedAtomFamily(PATH_A), true);

      expect(jotaiStore.get(sidebarCollapsedAtomFamily(PATH_A))).toBe(true);
      expect(jotaiStore.get(sidebarCollapsedAtomFamily(PATH_B))).toBe(false);
    });

    it('sidebarPreCollapseWidth is independent per path', () => {
      jotaiStore.set(sidebarPreCollapseWidthAtomFamily(PATH_A), 290);
      jotaiStore.set(sidebarPreCollapseWidthAtomFamily(PATH_B), 410);

      expect(jotaiStore.get(sidebarPreCollapseWidthAtomFamily(PATH_A))).toBe(290);
      expect(jotaiStore.get(sidebarPreCollapseWidthAtomFamily(PATH_B))).toBe(410);
    });

    it('aiChatWidth is independent per path', () => {
      jotaiStore.set(aiChatWidthAtomFamily(PATH_A), 600);
      jotaiStore.set(aiChatWidthAtomFamily(PATH_B), 280);

      expect(jotaiStore.get(aiChatWidthAtomFamily(PATH_A))).toBe(600);
      expect(jotaiStore.get(aiChatWidthAtomFamily(PATH_B))).toBe(280);
    });

    it('aiChatCollapsed is independent per path', () => {
      jotaiStore.set(aiChatCollapsedAtomFamily(PATH_A), true);

      expect(jotaiStore.get(aiChatCollapsedAtomFamily(PATH_A))).toBe(true);
      expect(jotaiStore.get(aiChatCollapsedAtomFamily(PATH_B))).toBe(false);
    });
  });

  describe('atom identity', () => {
    it('returns the same atom instance for the same path', () => {
      const first = sidebarWidthAtomFamily(PATH_A);
      const second = sidebarWidthAtomFamily(PATH_A);
      expect(first).toBe(second);
    });

    it('returns different atom instances for different paths', () => {
      const a = sidebarWidthAtomFamily(PATH_A);
      const b = sidebarWidthAtomFamily(PATH_B);
      expect(a).not.toBe(b);
    });
  });

  describe('defaults', () => {
    it('sidebar width defaults to 250', () => {
      expect(jotaiStore.get(sidebarWidthAtomFamily('/ws/fresh'))).toBe(250);
    });

    it('AI chat width defaults to 350', () => {
      expect(jotaiStore.get(aiChatWidthAtomFamily('/ws/fresh'))).toBe(350);
    });

    it('collapsed flags default to false', () => {
      expect(jotaiStore.get(sidebarCollapsedAtomFamily('/ws/fresh'))).toBe(false);
      expect(jotaiStore.get(aiChatCollapsedAtomFamily('/ws/fresh'))).toBe(false);
    });
  });
});
