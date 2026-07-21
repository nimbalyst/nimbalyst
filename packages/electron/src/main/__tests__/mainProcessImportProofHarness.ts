import { EventEmitter } from 'events';

type UnexpectedCall = { module: string; exportName: string };

const unexpectedCalls: UnexpectedCall[] = [];
const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();
const stores = new Set<InMemoryElectronStore>();
const appEvents = new EventEmitter();
const ipcEvents = new EventEmitter();

function recordUnexpected(module: string, exportName: string): undefined {
  unexpectedCalls.push({ module, exportName });
  return undefined;
}

const app = {
  on: appEvents.on.bind(appEvents),
  once: appEvents.once.bind(appEvents),
  off: appEvents.off.bind(appEvents),
  removeListener: appEvents.removeListener.bind(appEvents),
  removeAllListeners: appEvents.removeAllListeners.bind(appEvents),
  listenerCount: appEvents.listenerCount.bind(appEvents),
  getPath: () => `${process.cwd()}\\.tmp-electron-path`,
  getAppPath: () => `${process.cwd()}\\packages\\electron`,
  isPackaged: false,
};

const ipcMain = {
  handle(channel: string, handler: (...args: unknown[]) => unknown) {
    ipcHandlers.set(channel, handler);
  },
  removeHandler(channel: string) {
    ipcHandlers.delete(channel);
  },
  on: ipcEvents.on.bind(ipcEvents),
  once: ipcEvents.once.bind(ipcEvents),
  off: ipcEvents.off.bind(ipcEvents),
  removeListener: ipcEvents.removeListener.bind(ipcEvents),
  removeAllListeners: ipcEvents.removeAllListeners.bind(ipcEvents),
  listenerCount: ipcEvents.listenerCount.bind(ipcEvents),
  emit: ipcEvents.emit.bind(ipcEvents),
};

const windows = new Map<number, unknown>();
const windowStates = new Map<number, unknown>();
const savingWindows = new Set<number>();
const windowFocusOrder = new Map<number, number>();
const windowDevToolsState = new Map<number, boolean>();
const documentServices = new Map<string, unknown>();
const recentlyDeleted = new Set<string>();

function unexpectedWindowCall(exportName: string) {
  return () => recordUnexpected('../../../window/WindowManager', exportName);
}

const windowManager = {
  windows,
  windowStates,
  savingWindows,
  windowFocusOrder,
  windowDevToolsState,
  markRecentlyDeleted: (filePath: string) => { recentlyDeleted.add(filePath); },
  clearRecentlyDeleted: (filePath: string) => { recentlyDeleted.delete(filePath); },
  isRecentlyDeleted: (filePath: string) => recentlyDeleted.has(filePath),
  recentlyDeletedFiles: {
    has: (filePath: string) => recentlyDeleted.has(filePath),
    add: (filePath: string) => { recentlyDeleted.add(filePath); },
    delete: (filePath: string) => { recentlyDeleted.delete(filePath); },
  },
  documentServices,
  incrementFocusOrderCounter: unexpectedWindowCall('incrementFocusOrderCounter'),
  getFocusedOrNewWindow: unexpectedWindowCall('getFocusedOrNewWindow'),
  createWindow: unexpectedWindowCall('createWindow'),
  findWindowByFilePath: unexpectedWindowCall('findWindowByFilePath'),
  findWindowByWorkspace: unexpectedWindowCall('findWindowByWorkspace'),
  getMostRecentlyFocusedWorkspaceWindow: unexpectedWindowCall('getMostRecentlyFocusedWorkspaceWindow'),
  getWindowId: unexpectedWindowCall('getWindowId'),
};

const logSink = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

class InMemoryElectronStore {
  store: Record<string, unknown> = {};

  constructor() {
    stores.add(this);
  }

  get(key?: string, fallback?: unknown) {
    return key === undefined ? this.store : (this.store[key] ?? fallback);
  }

  set(key: string | Record<string, unknown>, value?: unknown) {
    if (typeof key === 'string') this.store[key] = value;
    else Object.assign(this.store, key);
  }

  delete(key: string) { delete this.store[key]; }
  clear() { this.store = {}; }
  onDidChange() { return () => undefined; }
  onDidAnyChange() { return () => undefined; }
}

const electronLog = {
  ...logSink,
  initialize: () => undefined,
  scope: () => logSink,
};

/** Fixed collection-only module allowlist for the Jean boundary proof. */
export const mainProcessImportProofModules = {
  electron: {
    app,
    ipcMain,
    BrowserWindow: {
      getAllWindows: () => [],
      fromId: () => null,
      getFocusedWindow: () => null,
      fromWebContents: () => null,
    },
  },
  windowManager,
  logger: { logger: { main: logSink, ai: logSink, database: logSink, analytics: logSink } },
  analytics: { AnalyticsService: { getInstance: () => ({ sendEvent: () => undefined }) } },
  electronStore: { default: InMemoryElectronStore },
  electronLog: { default: electronLog },
} as const;

const originalIpcMethods = {
  handle: ipcMain.handle,
  removeHandler: ipcMain.removeHandler,
  on: ipcMain.on,
  once: ipcMain.once,
  off: ipcMain.off,
  removeListener: ipcMain.removeListener,
  removeAllListeners: ipcMain.removeAllListeners,
  listenerCount: ipcMain.listenerCount,
  emit: ipcMain.emit,
};

/** Reset all collection-shell state before a proof and after a drained proof. */
export function resetMainProcessImportProofHarness(): void {
  unexpectedCalls.length = 0;
  ipcHandlers.clear();
  ipcEvents.removeAllListeners();
  appEvents.removeAllListeners();
  windows.clear();
  windowStates.clear();
  savingWindows.clear();
  windowFocusOrder.clear();
  windowDevToolsState.clear();
  documentServices.clear();
  recentlyDeleted.clear();
  for (const store of stores) store.clear();
  stores.clear();
  Object.assign(ipcMain, originalIpcMethods);
}

/** Fail closed if the import shell escaped its allowlist or retained local state. */
export function assertMainProcessImportProofHarnessDrained(): void {
  if (unexpectedCalls.length > 0) {
    throw new Error(`main_process_import_unexpected_call:${unexpectedCalls.map((call) => `${call.module}.${call.exportName}`).join(',')}`);
  }
  if (ipcHandlers.size > 0 || ipcEvents.eventNames().length > 0 || appEvents.eventNames().length > 0) {
    throw new Error('main_process_import_listener_or_handler_leak');
  }
  if (stores.size > 0 || windows.size > 0 || windowStates.size > 0 || savingWindows.size > 0
    || windowFocusOrder.size > 0 || windowDevToolsState.size > 0 || documentServices.size > 0
    || recentlyDeleted.size > 0) {
    throw new Error('main_process_import_state_leak');
  }
}
