import { describe, it, expect, vi } from 'vitest';
import { handleToolPermissionWithService, handleToolPermissionFallback } from '../toolAuthorization';
import { generateToolPattern } from '../../../permissions/toolPermissionHelpers';

function assertZodCompliantAllow(result: { behavior: string; updatedInput?: any; message?: string }) {
  expect(result.behavior).toBe('allow');
  expect(result.updatedInput).toBeDefined();
}

function assertZodCompliantDeny(result: { behavior: string; updatedInput?: any; message?: string }) {
  expect(result.behavior).toBe('deny');
  expect(result.message).toBeDefined();
  expect(typeof result.message).toBe('string');
}

describe('handleToolPermissionWithService', () => {
  function createDeps(overrides?: any) {
    return {
      logSecurity: vi.fn(),
      logAgentMessage: vi.fn().mockResolvedValue(undefined),
      requestToolPermission: vi.fn().mockResolvedValue({ decision: 'allow' }),
      ...overrides,
    };
  }

  function createParams(overrides?: any) {
    return {
      toolName: 'Bash',
      input: { command: 'npm test' },
      options: { signal: new AbortController().signal },
      sessionId: 'test-session',
      workspacePath: '/test/workspace',
      permissionsPath: undefined,
      teammateName: undefined,
      ...overrides,
    };
  }

  describe('Zod schema compliance', () => {
    it('allow decision includes updatedInput', async () => {
      const deps = createDeps();
      const result = await handleToolPermissionWithService(deps, createParams());
      assertZodCompliantAllow(result);
    });

    it('deny decision includes message', async () => {
      const deps = createDeps({ requestToolPermission: vi.fn().mockResolvedValue({ decision: 'deny' }) });
      const result = await handleToolPermissionWithService(deps, createParams());
      assertZodCompliantDeny(result);
    });

    it('error path includes message', async () => {
      const deps = createDeps({
        requestToolPermission: vi.fn().mockRejectedValue(new Error('Network timeout')),
      });
      const result = await handleToolPermissionWithService(deps, createParams());
      assertZodCompliantDeny(result);
      expect(result.message).toBe('Network timeout');
    });

    it('non-Error thrown includes fallback message', async () => {
      const deps = createDeps({
        requestToolPermission: vi.fn().mockRejectedValue('string error'),
      });
      const result = await handleToolPermissionWithService(deps, createParams());
      assertZodCompliantDeny(result);
      expect(result.message).toBe('Permission request cancelled');
    });
  });
});

describe('handleToolPermissionFallback', () => {
  function createDeps(overrides?: any) {
    return {
      permissions: {
        sessionApprovedPatterns: new Set<string>(),
        pendingToolPermissions: new Map(),
      },
      logSecurity: vi.fn(),
      logAgentMessage: vi.fn().mockResolvedValue(undefined),
      emit: vi.fn(),
      pollForPermissionResponse: vi.fn().mockResolvedValue(undefined),
      savePattern: vi.fn().mockResolvedValue(undefined),
      logError: vi.fn(),
      ...overrides,
    };
  }

  function createParams(overrides?: any) {
    return {
      toolName: 'Bash',
      input: { command: 'npm test' },
      options: { signal: new AbortController().signal },
      sessionId: 'test-session',
      workspacePath: '/test/workspace',
      ...overrides,
    };
  }

  describe('Zod schema compliance', () => {
    it('session-cached pattern allow includes updatedInput', async () => {
      const input = { command: 'npm test' };
      const deps = createDeps();
      deps.permissions.sessionApprovedPatterns.add(generateToolPattern('Bash', input));
      const result = await handleToolPermissionFallback(deps, createParams());
      assertZodCompliantAllow(result);
    });

    it('WebFetch wildcard allow includes updatedInput', async () => {
      const deps = createDeps();
      deps.permissions.sessionApprovedPatterns.add('WebFetch');
      const params = createParams({ toolName: 'WebFetch', input: { url: 'https://example.com' } });
      const result = await handleToolPermissionFallback(deps, params);
      assertZodCompliantAllow(result);
    });

    it('user allow response includes updatedInput', async () => {
      const deps = createDeps();
      const params = createParams();
      const resultPromise = handleToolPermissionFallback(deps, params);

      // Simulate user approving via the pending permission map
      await vi.waitFor(() => {
        expect(deps.permissions.pendingToolPermissions.size).toBe(1);
      });
      const [, pending] = [...deps.permissions.pendingToolPermissions.entries()][0];
      pending.resolve({ decision: 'allow', scope: 'once' });

      const result = await resultPromise;
      assertZodCompliantAllow(result);
    });

    it('user deny response includes message', async () => {
      const deps = createDeps();
      const params = createParams();
      const resultPromise = handleToolPermissionFallback(deps, params);

      await vi.waitFor(() => {
        expect(deps.permissions.pendingToolPermissions.size).toBe(1);
      });
      const [, pending] = [...deps.permissions.pendingToolPermissions.entries()][0];
      pending.resolve({ decision: 'deny', scope: 'once' });

      const result = await resultPromise;
      assertZodCompliantDeny(result);
    });

    it('abort signal deny includes message', async () => {
      const controller = new AbortController();
      const deps = createDeps();
      const params = createParams({ options: { signal: controller.signal } });
      const resultPromise = handleToolPermissionFallback(deps, params);

      await vi.waitFor(() => {
        expect(deps.permissions.pendingToolPermissions.size).toBe(1);
      });
      controller.abort();

      const result = await resultPromise;
      assertZodCompliantDeny(result);
    });

    it('rejected promise deny includes message', async () => {
      const deps = createDeps();
      const params = createParams();
      const resultPromise = handleToolPermissionFallback(deps, params);

      await vi.waitFor(() => {
        expect(deps.permissions.pendingToolPermissions.size).toBe(1);
      });
      const [, pending] = [...deps.permissions.pendingToolPermissions.entries()][0];
      pending.reject(new Error('Session ended'));

      const result = await resultPromise;
      assertZodCompliantDeny(result);
      expect(result.message).toBe('Session ended');
    });
  });

  describe('pattern persistence', () => {
    it('allow-always saves pattern to disk', async () => {
      const deps = createDeps();
      const params = createParams();
      const resultPromise = handleToolPermissionFallback(deps, params);

      await vi.waitFor(() => {
        expect(deps.permissions.pendingToolPermissions.size).toBe(1);
      });
      const [, pending] = [...deps.permissions.pendingToolPermissions.entries()][0];
      pending.resolve({ decision: 'allow', scope: 'always' });

      await resultPromise;
      expect(deps.savePattern).toHaveBeenCalled();
    });

    it('allow-session adds to session cache but not disk', async () => {
      const deps = createDeps();
      const params = createParams();
      const resultPromise = handleToolPermissionFallback(deps, params);

      await vi.waitFor(() => {
        expect(deps.permissions.pendingToolPermissions.size).toBe(1);
      });
      const [, pending] = [...deps.permissions.pendingToolPermissions.entries()][0];
      pending.resolve({ decision: 'allow', scope: 'session' });

      await resultPromise;
      expect(deps.permissions.sessionApprovedPatterns.size).toBe(1);
      expect(deps.savePattern).not.toHaveBeenCalled();
    });

    it('allow-once does not cache or save', async () => {
      const deps = createDeps();
      const params = createParams();
      const resultPromise = handleToolPermissionFallback(deps, params);

      await vi.waitFor(() => {
        expect(deps.permissions.pendingToolPermissions.size).toBe(1);
      });
      const [, pending] = [...deps.permissions.pendingToolPermissions.entries()][0];
      pending.resolve({ decision: 'allow', scope: 'once' });

      await resultPromise;
      expect(deps.permissions.sessionApprovedPatterns.size).toBe(0);
      expect(deps.savePattern).not.toHaveBeenCalled();
    });
  });
});
