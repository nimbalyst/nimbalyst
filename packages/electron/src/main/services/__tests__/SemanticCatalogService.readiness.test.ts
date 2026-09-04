// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineStatus } from '../../../../../extensions/nimbalyst-memory/engine/src/engine';

const { host, moduleStates, stateListeners } = vi.hoisted(() => {
  const states = new Map<string, { status: string }>();
  const listeners: Array<(handle: any) => void> = [];
  return {
    moduleStates: states,
    stateListeners: listeners,
    host: {
      list: vi.fn(() => []),
      getState: vi.fn((_extensionId: string, _moduleId: string, workspacePath: string) =>
        states.get(workspacePath)
      ),
      onStateChanged: vi.fn((listener: (handle: any) => void) => {
        listeners.push(listener);
        return () => undefined;
      }),
      request: vi.fn(),
    },
  };
});

vi.mock('../../extensions/PrivilegedExtensionHost', () => ({
  getPrivilegedExtensionHost: () => host,
}));

vi.mock('../../window/WindowManager', () => ({
  documentServices: new Map(),
}));

vi.mock('../../utils/store', () => ({
  getAppSetting: vi.fn(),
  setAppSetting: vi.fn(),
}));

import { SemanticCatalogService } from '../SemanticCatalogService';

const WORKSPACE = '/workspace/project';
const MEMORY_MODULE = {
  extensionId: 'com.nimbalyst.memory',
  moduleId: 'memory-engine',
  workspacePath: WORKSPACE,
};

/**
 * The real `status` payload: the backend module's own `ready` flag spread over
 * `buildPublicEngineStatus(engine.status())`, i.e. `EngineStatus` minus
 * `lastEmbedError`.
 *
 * Typing the engine half against the engine's own `EngineStatus` is the whole
 * point of this helper. A previous fix read a `ready` field off the *engine*
 * half — which has no such field — and its test passed only because the mock
 * had been told to return one, shipping semantic search permanently disabled.
 * Here an invented field is a compile error, and a new required engine field
 * forces whoever adds it to look at this consumer.
 */
function statusPayload(
  overrides: Partial<Omit<EngineStatus, 'lastEmbedError'>> = {}
): Record<string, unknown> {
  const engine: Omit<EngineStatus, 'lastEmbedError'> = {
    chunks: 0,
    denseChunks: 0,
    bySourceClass: {},
    sourceFiles: 0,
    lastIndexedAt: null,
    embedder: { id: 'sparse', model: 'sparse', dims: 0 },
    embedderChanged: false,
    indexing: false,
    retrieval: {
      mode: 'hybrid',
      semantic: { available: true },
      keyword: { available: true, source: 'local-project-index' },
    },
    root: WORKSPACE,
  };
  return { ready: true, ...engine, ...overrides };
}

/** The backend's other branch: the engine never constructed. */
const ENGINE_ABSENT = {
  ready: false,
  capability: { available: false, reason: 'local-project-index-unavailable' },
  root: WORKSPACE,
};

function emitState(status: 'running' | 'stopped'): void {
  const state =
    status === 'running'
      ? { status, startedAt: Date.now(), methods: ['status'] }
      : { status, stoppedAt: Date.now() };
  moduleStates.set(WORKSPACE, state);
  for (const listener of stateListeners) listener({ ...MEMORY_MODULE, state });
}

describe('SemanticCatalogService readiness', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    moduleStates.clear();
    stateListeners.length = 0;
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('fails closed when the running module has no engine', async () => {
    host.request.mockResolvedValue(ENGINE_ABSENT);
    const service = new SemanticCatalogService();
    service.start();

    emitState('running');
    await vi.waitFor(() => expect(host.request).toHaveBeenCalledTimes(1));

    expect(service.isAvailable(WORKSPACE)).toBe(false);
    await expect(service.query(WORKSPACE, 'memory')).resolves.toEqual({
      available: false,
      results: [],
    });
  });

  it('is available on a partially built index and stops polling once chunks land', async () => {
    host.request
      // Cold start: engine up, nothing indexed yet.
      .mockResolvedValueOnce(statusPayload({ chunks: 0, indexing: true }))
      // Mid-pass: the engine refreshes its snapshot every 25 files, so partial
      // results are searchable long before `indexing` goes false.
      .mockResolvedValueOnce(statusPayload({ chunks: 40, indexing: true }));
    const service = new SemanticCatalogService();
    service.start();

    emitState('running');
    await vi.waitFor(() => expect(host.request).toHaveBeenCalledTimes(1));

    // Hot path is a cached read: repeated calls issue no further RPCs.
    expect(service.isAvailable(WORKSPACE)).toBe(false);
    expect(service.isAvailable(WORKSPACE)).toBe(false);
    expect(host.request).toHaveBeenCalledTimes(1);
    expect(host.request).toHaveBeenCalledWith({
      extensionId: 'com.nimbalyst.memory',
      moduleId: 'memory-engine',
      workspacePath: WORKSPACE,
      method: 'status',
      requiredPermission: null,
    });

    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(service.isAvailable(WORKSPACE)).toBe(true));

    // Terminates: available, so no retry is armed even though indexing continues.
    await vi.advanceTimersByTimeAsync(5000);
    expect(host.request).toHaveBeenCalledTimes(2);

    emitState('stopped');
    expect(service.isAvailable(WORKSPACE)).toBe(false);
  });

  it('treats keyword-only retrieval as available', async () => {
    // No embedder: the sparse fallback is a working state, not an outage.
    host.request.mockResolvedValue(
      statusPayload({
        chunks: 120,
        denseChunks: 0,
        retrieval: {
          mode: 'keyword-only',
          semantic: { available: false, reason: 'optional-embedding-provider-unavailable' },
          keyword: { available: true, source: 'local-project-index' },
        },
      })
    );
    const service = new SemanticCatalogService();
    service.start();

    emitState('running');
    await vi.waitFor(() => expect(service.isAvailable(WORKSPACE)).toBe(true));
  });
});
