// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const terminalWrite = vi.hoisted(() => vi.fn());

// Keep electron-log's real routing and level filters; replace only its sinks.
vi.mock('electron-log/main', async () => {
  const { default: nodeLog } = await import('electron-log/node');
  const log = nodeLog.create({ logId: 'logger-routing-test' });
  Object.assign(log, { initialize: vi.fn() });
  log.transports.file = Object.assign(vi.fn(), { level: 'silly' }) as any;
  log.transports.ipc = Object.assign(vi.fn(), { level: 'silly' }) as any;
  log.transports.console.writeFn = terminalWrite;
  return { default: log };
});

vi.mock('../privateSettingsStore', () => ({
  default: class {
    get(_key: string, fallback: unknown) { return fallback; }
    set() {}
  },
}));

describe('main-process log routing', () => {
  let originalConsole: ReturnType<typeof import('../logger').overrideConsole> | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.stubEnv('VITEST', '');
    vi.stubEnv('NODE_ENV', 'development');
  });

  afterEach(() => {
    if (originalConsole) Object.assign(console, originalConsole);
    originalConsole = undefined;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('writes once per sink without broadcasting main logs into every renderer', async () => {
    const { overrideConsole, updateLoggerConfig, LogLevel } = await import('../logger');
    const { default: log } = await import('electron-log/main');
    updateLoggerConfig({ globalLevel: LogLevel.INFO });
    const directWrite = vi.spyOn(console, 'warn').mockImplementation(() => {});
    originalConsole = overrideConsole();

    console.warn('sync failed', new Error('timeout'));

    expect(log.transports.file).toHaveBeenCalledTimes(1);
    expect(terminalWrite).toHaveBeenCalledTimes(1);
    expect(log.transports.ipc).not.toHaveBeenCalled();
    expect(directWrite).not.toHaveBeenCalled();
    expect(log.transports.file).toHaveBeenCalledWith(expect.objectContaining({
      level: 'warn', data: [expect.stringContaining('Error: timeout')],
    }));
  });

  it('honors quiet console settings while retaining errors in the file', async () => {
    const { overrideConsole, updateLoggerConfig } = await import('../logger');
    const { default: log } = await import('electron-log/main');
    updateLoggerConfig({ consoleLogging: false });
    const directWrite = vi.spyOn(console, 'error').mockImplementation(() => {});
    originalConsole = overrideConsole();

    console.error('disk write failed');

    expect(log.transports.file).toHaveBeenCalledTimes(1);
    expect(terminalWrite).not.toHaveBeenCalled();
    expect(directWrite).not.toHaveBeenCalled();
  });

  it('keeps routine debug output quiet by default, with explicit opt-in', async () => {
    const { overrideConsole, logger, updateLoggerConfig, updateComponentConfig, LogComponent, LogLevel } = await import('../logger');
    const { default: log } = await import('electron-log/main');
    const directWrite = vi.spyOn(console, 'debug').mockImplementation(() => {});
    originalConsole = overrideConsole();

    console.debug('routine polling');
    logger.aiClaude.debug('provider detail');
    expect(log.transports.file).not.toHaveBeenCalled();
    expect(terminalWrite).not.toHaveBeenCalled();
    expect(directWrite).not.toHaveBeenCalled();

    updateLoggerConfig({ globalLevel: LogLevel.DEBUG });
    updateComponentConfig(LogComponent.MAIN, true, LogLevel.DEBUG);
    console.debug('requested detail');
    expect(log.transports.file).toHaveBeenCalledTimes(1);
    expect(terminalWrite).toHaveBeenCalledTimes(1);
  });
});
