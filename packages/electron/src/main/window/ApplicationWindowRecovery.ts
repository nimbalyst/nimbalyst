import { app, type BrowserWindow } from 'electron';
import { getProjectWindows } from './windowState';
import { logger } from '../utils/logger';
import { isStartupActivationPending } from './StartupActivation';

interface RecoveryDependencies {
    isQuitting(): boolean;
    getPreferredProjectWindow(): BrowserWindow | null;
    getWorkspaceManagerWindow(): BrowserWindow | null;
    createWorkspaceManagerWindow(options?: { revealInactive?: boolean }): BrowserWindow;
    wasWorkspaceManagerManuallyClosed(): boolean;
}

let dependencies: RecoveryDependencies | null = null;
let pendingRecovery: ReturnType<typeof setImmediate> | null = null;
// Only macOS emits the active/resign events, so elsewhere this stays true.
let appActive = true;

/** The project window the user last worked in, else any survivor. Hidden windows count. */
export function getRestorableProjectWindow(): BrowserWindow | null {
    const preferred = dependencies?.getPreferredProjectWindow() ?? null;
    const projects = getProjectWindows();
    return (preferred && projects.includes(preferred) ? preferred : projects[0]) ?? null;
}

/** #1609: auxiliary render/preview windows must never count as app windows. */
export function restoreApplicationWindow(): void {
    if (!dependencies) throw new Error('Application window recovery has not been initialized');
    if (dependencies.isQuitting() || !app.isReady() || isStartupActivationPending()) return;

    const target = getRestorableProjectWindow() ?? dependencies.getWorkspaceManagerWindow();
    if (target && !target.isDestroyed()) {
        logger.main.info('[WindowLifecycle] Restoring app window', { windowId: target.id });
        if (target.isMinimized()) target.restore();
        target.show();
        target.focus();
    } else {
        logger.main.info('[WindowLifecycle] No app window remains; opening Project Manager');
        // Creation owns ready-to-show. Do not reveal an unpainted window here.
        dependencies.createWorkspaceManagerWindow();
    }
}

/** Called after a managed window is removed, even if a hidden helper survives. */
export function recoverAfterProjectWindowClosed(): void {
    if (!dependencies || dependencies.isQuitting() || pendingRecovery) return;
    // Let all closed listeners finish and any synchronous replacement register.
    pendingRecovery = setImmediate(() => {
        pendingRecovery = null;
        if (!dependencies || dependencies.isQuitting() || !app.isReady()) return;
        if (getProjectWindows().length > 0) return;
        const manager = dependencies.getWorkspaceManagerWindow();
        if (manager && !manager.isDestroyed()) return;
        // Decided here rather than in window-all-closed, which a hidden helper
        // window can keep from ever firing.
        if (dependencies.wasWorkspaceManagerManuallyClosed()) {
            logger.main.info('[WindowLifecycle] Project Manager was closed by the user; not reopening it');
            if (process.platform !== 'darwin') app.quit();
            return;
        }
        if (isStartupActivationPending()) return;
        logger.main.info('[WindowLifecycle] Last project window closed; opening Project Manager', { appActive });
        // A window that closed while the user was in another app must not pull them back.
        dependencies.createWorkspaceManagerWindow({ revealInactive: !appActive });
    });
}

/** Wired from index to avoid importing its startup graph through tray/window code. */
export function initializeApplicationWindowRecovery(deps: RecoveryDependencies): () => void {
    if (dependencies) throw new Error('Application window recovery is already initialized');
    dependencies = deps;
    const onActivate = () => restoreApplicationWindow();
    const onAllClosed = () => {
        logger.main.info('All windows closed');
        if (deps.isQuitting()) {
            app.quit();
            return;
        }
        recoverAfterProjectWindowClosed();
    };
    const onBecomeActive = () => { appActive = true; };
    const onResignActive = () => { appActive = false; };
    app.on('activate', onActivate);
    app.on('window-all-closed', onAllClosed);
    app.on('did-become-active', onBecomeActive);
    app.on('did-resign-active', onResignActive);
    return () => {
        app.removeListener('activate', onActivate);
        app.removeListener('window-all-closed', onAllClosed);
        app.removeListener('did-become-active', onBecomeActive);
        app.removeListener('did-resign-active', onResignActive);
        if (pendingRecovery) clearImmediate(pendingRecovery);
        pendingRecovery = null;
        dependencies = null;
        appActive = true;
    };
}
