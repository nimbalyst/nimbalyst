import { beforeEach, describe, expect, it, vi } from 'vitest';

const showErrorBox = vi.fn();
const sendEvent = vi.fn();
const startTutorialProject = vi.fn();

vi.mock('electron', () => ({
    dialog: {
        showErrorBox: (...args: unknown[]) => showErrorBox(...args),
    },
}));

vi.mock('../../utils/logger', () => ({
    logger: { menu: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } },
}));

vi.mock('../../services/analytics/AnalyticsService', () => ({
    AnalyticsService: {
        getInstance: () => ({ sendEvent }),
    },
}));

vi.mock('../../window/WorkspaceManagerWindow.ts', () => ({
    startTutorialProject: () => startTutorialProject(),
}));

import { launchTutorialFromMenu } from '../helpMenuActions';

beforeEach(() => {
    vi.clearAllMocks();
});

describe('launchTutorialFromMenu', () => {
    it('starts the tutorial project and tracks the menu access', async () => {
        startTutorialProject.mockResolvedValue({
            success: true,
            workspacePath: '/Users/test/Documents/Nimbalyst Tutorial',
            reused: false,
        });

        await launchTutorialFromMenu();

        expect(startTutorialProject).toHaveBeenCalledOnce();
        expect(sendEvent).toHaveBeenCalledWith('help_accessed', {
            helpType: 'tutorial',
            context: 'menu',
        });
        expect(showErrorBox).not.toHaveBeenCalled();
    });

    it('surfaces a failed materialization in an error dialog', async () => {
        startTutorialProject.mockResolvedValue({
            success: false,
            error: 'Tutorial template directory does not exist: /nope',
        });

        await launchTutorialFromMenu();

        expect(showErrorBox).toHaveBeenCalledWith(
            'Tutorial Unavailable',
            expect.stringContaining('Tutorial template directory does not exist: /nope')
        );
    });
});
