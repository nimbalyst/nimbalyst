import { afterEach, describe, expect, it, vi } from 'vitest';

const { matchWorkspaceFileEdit, addFileLink, debug } = vi.hoisted(() => ({
  matchWorkspaceFileEdit: vi.fn(),
  addFileLink: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('@nimbalyst/runtime', () => ({
  SessionFilesRepository: { addFileLink },
}));

vi.mock('../../HistoryManager', () => ({
  historyManager: { createTag: vi.fn() },
}));

vi.mock('../../file/WorkspaceEventBus', () => ({
  getSubscriberIds: vi.fn(() => ['legacy-session']),
}));

vi.mock('../../utils/logger', () => ({
  logger: {
    main: { debug, info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  },
}));

vi.mock('../../utils/fileFilters', () => ({
  pathContainsExcludedDir: vi.fn(() => false),
}));

vi.mock('../SessionEditQuota', () => ({
  sessionEditQuota: { tryReserve: vi.fn(() => Promise.resolve(true)) },
}));

vi.mock('../WorkspaceAttributionThrottle', () => ({
  workspaceAttributionThrottle: { tryAcquire: vi.fn(() => true) },
}));

vi.mock('../ToolCallMatcher', () => ({
  toolCallMatcher: { matchWorkspaceFileEdit },
}));

vi.mock('../CodexEditWindowRegistry', () => ({
  codexEditWindowRegistry: {
    findWindowForEdit: vi.fn(() => null),
    recordObservation: vi.fn(),
  },
}));

vi.mock('../sessionFilesNotify', () => ({
  notifySessionFilesUpdated: vi.fn(),
}));

import { workspaceFileAttributionPolicy } from '../WorkspaceFileAttributionPolicy';
import { workspaceFileEditAttributionService } from '../WorkspaceFileEditAttributionService';

describe('WorkspaceFileEditAttributionService', () => {
  afterEach(() => {
    workspaceFileAttributionPolicy.__resetForTests();
    matchWorkspaceFileEdit.mockReset();
    addFileLink.mockReset();
    debug.mockReset();
  });

  it('drops pooled listener events workspace-wide while app-server attribution is disabled', async () => {
    workspaceFileAttributionPolicy.set('app-server-session', '/workspace', 'disabled');

    workspaceFileEditAttributionService.ingestWatcherEvent({
      workspacePath: '/workspace',
      filePath: '/workspace/src/app.ts',
      timestamp: Date.now(),
      beforeContent: 'before',
    });

    await vi.waitFor(() => {
      expect(debug).toHaveBeenCalledWith(
        '[WorkspaceFileEditAttributionService] Listener attribution disabled for workspace:',
        expect.objectContaining({ filePath: '/workspace/src/app.ts' }),
      );
    });
    expect(matchWorkspaceFileEdit).not.toHaveBeenCalled();
    expect(addFileLink).not.toHaveBeenCalled();
  });
});
