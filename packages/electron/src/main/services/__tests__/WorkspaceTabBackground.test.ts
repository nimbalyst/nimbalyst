import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  anyWindowReferencesWorkspace: vi.fn(() => true),
  startWatchingWorkspaceConfig: vi.fn(),
  autoMatchTeamForWorkspace: vi.fn(async () => undefined),
  initializeTrackerSync: vi.fn(async () => undefined),
  updateTrackerSchemaWorkspace: vi.fn(),
}));

vi.mock('../../window/windowState', () => ({
  anyWindowReferencesWorkspace: mocks.anyWindowReferencesWorkspace,
}));

vi.mock('../../mcpConfigServiceRef', () => ({
  getMcpConfigService: () => ({
    startWatchingWorkspaceConfig: mocks.startWatchingWorkspaceConfig,
  }),
}));

vi.mock('../TeamService', () => ({
  autoMatchTeamForWorkspace: mocks.autoMatchTeamForWorkspace,
}));

vi.mock('../TrackerSyncManager', () => ({
  initializeTrackerSync: mocks.initializeTrackerSync,
}));

vi.mock('../TrackerSchemaService', () => ({
  updateTrackerSchemaWorkspace: mocks.updateTrackerSchemaWorkspace,
}));

vi.mock('../../utils/logger', () => ({
  logger: {
    main: {
      error: vi.fn(),
      warn: vi.fn(),
    },
  },
}));

import {
  activateWorkspaceTabContext,
  initializeWorkspaceTabBackground,
  releaseWorkspaceTabBackground,
} from '../WorkspaceTabBackground';

describe('WorkspaceTabBackground', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.anyWindowReferencesWorkspace.mockReset();
    mocks.anyWindowReferencesWorkspace.mockReturnValue(true);
    mocks.startWatchingWorkspaceConfig.mockReset();
    mocks.autoMatchTeamForWorkspace.mockReset();
    mocks.autoMatchTeamForWorkspace.mockResolvedValue(undefined);
    mocks.initializeTrackerSync.mockReset();
    mocks.initializeTrackerSync.mockResolvedValue(undefined);
    mocks.updateTrackerSchemaWorkspace.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('initializes each referenced workspace only once per lifecycle', async () => {
    const workspacePath = '/ws/once';

    initializeWorkspaceTabBackground(workspacePath);
    initializeWorkspaceTabBackground(workspacePath);
    await vi.runAllTimersAsync();

    expect(mocks.startWatchingWorkspaceConfig).toHaveBeenCalledOnce();
    expect(mocks.autoMatchTeamForWorkspace).toHaveBeenCalledOnce();
    expect(mocks.initializeTrackerSync).toHaveBeenCalledOnce();
    releaseWorkspaceTabBackground(workspacePath);
  });

  it('activates tracker schema context without restarting background services', async () => {
    const workspacePath = '/ws/activation';
    initializeWorkspaceTabBackground(workspacePath);
    await vi.runAllTimersAsync();
    mocks.startWatchingWorkspaceConfig.mockClear();
    mocks.autoMatchTeamForWorkspace.mockClear();
    mocks.initializeTrackerSync.mockClear();

    activateWorkspaceTabContext(workspacePath);
    activateWorkspaceTabContext(workspacePath);

    expect(mocks.updateTrackerSchemaWorkspace).toHaveBeenCalledTimes(2);
    expect(mocks.startWatchingWorkspaceConfig).not.toHaveBeenCalled();
    expect(mocks.autoMatchTeamForWorkspace).not.toHaveBeenCalled();
    expect(mocks.initializeTrackerSync).not.toHaveBeenCalled();
    releaseWorkspaceTabBackground(workspacePath);
  });

  it('ignores stale deferred work after a release and quick reopen', async () => {
    const workspacePath = '/ws/reopen';

    initializeWorkspaceTabBackground(workspacePath);
    releaseWorkspaceTabBackground(workspacePath);
    initializeWorkspaceTabBackground(workspacePath);
    await vi.runAllTimersAsync();

    expect(mocks.startWatchingWorkspaceConfig).toHaveBeenCalledOnce();
    expect(mocks.autoMatchTeamForWorkspace).toHaveBeenCalledOnce();
    expect(mocks.initializeTrackerSync).toHaveBeenCalledOnce();
    releaseWorkspaceTabBackground(workspacePath);
  });

  it('releases the guard when deferred work finds no window reference', async () => {
    const workspacePath = '/ws/closed-before-init';
    mocks.anyWindowReferencesWorkspace.mockReturnValue(false);

    initializeWorkspaceTabBackground(workspacePath);
    await vi.runAllTimersAsync();
    expect(mocks.startWatchingWorkspaceConfig).not.toHaveBeenCalled();

    mocks.anyWindowReferencesWorkspace.mockReturnValue(true);
    initializeWorkspaceTabBackground(workspacePath);
    await vi.runAllTimersAsync();

    expect(mocks.startWatchingWorkspaceConfig).toHaveBeenCalledOnce();
    releaseWorkspaceTabBackground(workspacePath);
  });
});
