import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderSessionManager } from '../ProviderSessionManager';

describe('ProviderSessionManager', () => {
  let emit: ReturnType<typeof vi.fn<(event: string, data: unknown) => boolean>>;
  let manager: ProviderSessionManager;

  beforeEach(() => {
    emit = vi.fn<(event: string, data: unknown) => boolean>(() => true);
    manager = new ProviderSessionManager({ emit });
  });

  describe('captureSessionId', () => {
    it('stores the provider session ID and emits event', () => {
      manager.captureSessionId('session-1', 'provider-abc');

      expect(manager.getSessionId('session-1')).toBe('provider-abc');
      expect(emit).toHaveBeenCalledOnce();
      expect(emit).toHaveBeenCalledWith('session:providerSessionReceived', {
        sessionId: 'session-1',
        providerSessionId: 'provider-abc',
      });
    });

    it('is idempotent - does not emit when called with the same value', () => {
      manager.captureSessionId('session-1', 'provider-abc');
      emit.mockClear();

      manager.captureSessionId('session-1', 'provider-abc');

      expect(emit).not.toHaveBeenCalled();
      expect(manager.getSessionId('session-1')).toBe('provider-abc');
    });

    it('emits when the provider session ID changes', () => {
      manager.captureSessionId('session-1', 'provider-abc');
      emit.mockClear();

      manager.captureSessionId('session-1', 'provider-xyz');

      expect(manager.getSessionId('session-1')).toBe('provider-xyz');
      expect(emit).toHaveBeenCalledOnce();
      expect(emit).toHaveBeenCalledWith('session:providerSessionReceived', {
        sessionId: 'session-1',
        providerSessionId: 'provider-xyz',
      });
    });
  });

  describe('getSessionId', () => {
    it('returns undefined for unknown sessions', () => {
      expect(manager.getSessionId('unknown')).toBeUndefined();
    });

    it('returns the stored value', () => {
      manager.captureSessionId('s1', 'p1');
      expect(manager.getSessionId('s1')).toBe('p1');
    });
  });

  describe('hasSession', () => {
    it('returns false for unknown sessions', () => {
      expect(manager.hasSession('unknown')).toBe(false);
    });

    it('returns true for stored sessions', () => {
      manager.captureSessionId('s1', 'p1');
      expect(manager.hasSession('s1')).toBe(true);
    });
  });

  describe('deleteSession', () => {
    it('removes the mapping without emitting', () => {
      manager.captureSessionId('s1', 'p1');
      emit.mockClear();

      manager.deleteSession('s1');

      expect(manager.getSessionId('s1')).toBeUndefined();
      expect(emit).not.toHaveBeenCalled();
    });

    it('is safe to call for non-existent sessions', () => {
      manager.deleteSession('unknown');
      expect(emit).not.toHaveBeenCalled();
    });
  });

  describe('expireSession', () => {
    it('removes the mapping and emits providerSessionExpired', () => {
      manager.captureSessionId('s1', 'p1');
      emit.mockClear();

      manager.expireSession('s1');

      expect(manager.getSessionId('s1')).toBeUndefined();
      expect(emit).toHaveBeenCalledOnce();
      expect(emit).toHaveBeenCalledWith('session:providerSessionExpired', {
        sessionId: 's1',
      });
    });

    it('emits even when no prior mapping exists', () => {
      manager.expireSession('unknown');

      expect(emit).toHaveBeenCalledOnce();
      expect(emit).toHaveBeenCalledWith('session:providerSessionExpired', {
        sessionId: 'unknown',
      });
    });
  });

  describe('setProviderSessionData', () => {
    it('stores providerSessionId without emitting', () => {
      manager.setProviderSessionData('s1', { providerSessionId: 'p1' });

      expect(manager.getSessionId('s1')).toBe('p1');
      expect(emit).not.toHaveBeenCalled();
    });

    it('accepts claudeSessionId as fallback', () => {
      manager.setProviderSessionData('s1', { claudeSessionId: 'claude-123' });

      expect(manager.getSessionId('s1')).toBe('claude-123');
      expect(emit).not.toHaveBeenCalled();
    });

    it('accepts codexThreadId as fallback', () => {
      manager.setProviderSessionData('s1', { codexThreadId: 'thread-456' });

      expect(manager.getSessionId('s1')).toBe('thread-456');
      expect(emit).not.toHaveBeenCalled();
    });

    it('prefers providerSessionId over legacy keys', () => {
      manager.setProviderSessionData('s1', {
        providerSessionId: 'canonical',
        claudeSessionId: 'legacy-claude',
        codexThreadId: 'legacy-codex',
      });

      expect(manager.getSessionId('s1')).toBe('canonical');
    });

    it('ignores empty/undefined values', () => {
      manager.setProviderSessionData('s1', {});
      expect(manager.getSessionId('s1')).toBeUndefined();

      manager.setProviderSessionData('s2', { providerSessionId: '' });
      expect(manager.getSessionId('s2')).toBeUndefined();
    });
  });

  describe('getProviderSessionData', () => {
    it('returns { providerSessionId: undefined } for unknown sessions', () => {
      expect(manager.getProviderSessionData('unknown')).toEqual({
        providerSessionId: undefined,
      });
    });

    it('returns the canonical shape with stored value', () => {
      manager.captureSessionId('s1', 'p1');
      expect(manager.getProviderSessionData('s1')).toEqual({
        providerSessionId: 'p1',
      });
    });
  });

  describe('clear', () => {
    it('removes all mappings without emitting', () => {
      manager.captureSessionId('s1', 'p1');
      manager.captureSessionId('s2', 'p2');
      emit.mockClear();

      manager.clear();

      expect(manager.size).toBe(0);
      expect(manager.getSessionId('s1')).toBeUndefined();
      expect(manager.getSessionId('s2')).toBeUndefined();
      expect(emit).not.toHaveBeenCalled();
    });
  });

  describe('size', () => {
    it('returns 0 for empty manager', () => {
      expect(manager.size).toBe(0);
    });

    it('tracks the number of stored sessions', () => {
      manager.captureSessionId('s1', 'p1');
      expect(manager.size).toBe(1);

      manager.captureSessionId('s2', 'p2');
      expect(manager.size).toBe(2);

      manager.deleteSession('s1');
      expect(manager.size).toBe(1);
    });
  });
});
