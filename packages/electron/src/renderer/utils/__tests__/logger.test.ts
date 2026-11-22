// @vitest-environment node
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

// Fake electron-log: every scope name gets its own set of spy functions, so a
// test can check exactly which scope and which level a call reached.
const scopes = vi.hoisted(() => new Map<string, Record<string, Mock>>());

vi.mock('electron-log/renderer', () => {
  const makeScope = (name: string) => {
    if (!scopes.has(name)) {
      scopes.set(name, {
        error: vi.fn(),
        warn: vi.fn(),
        info: vi.fn(),
        verbose: vi.fn(),
        debug: vi.fn(),
        silly: vi.fn(),
      });
    }
    return scopes.get(name)!;
  };
  return {
    default: {
      scope: makeScope,
      transports: { console: {} },
    },
  };
});

import { logger } from '../logger';

describe('renderer logger', () => {
  beforeEach(() => {
    for (const scope of scopes.values()) {
      Object.values(scope).forEach((fn) => fn.mockClear());
    }
  });

  // #1818: the UI scope is switched off, but a dropped error left no trace in
  // main.log. Errors must still get through.
  it('logs errors for a switched-off scope', () => {
    logger.ui.error('x');
    expect(scopes.get('UI')!.error).toHaveBeenCalledWith('x');
  });

  it('still drops info and warn for a switched-off scope', () => {
    logger.ui.info('x');
    logger.ui.warn('x');
    expect(scopes.get('UI')!.info).not.toHaveBeenCalled();
    expect(scopes.get('UI')!.warn).not.toHaveBeenCalled();
  });

  it('logs warn for a scope that is switched on', () => {
    logger.renderer.warn('x');
    expect(scopes.get('RENDERER')!.warn).toHaveBeenCalledWith('x');
  });
});
