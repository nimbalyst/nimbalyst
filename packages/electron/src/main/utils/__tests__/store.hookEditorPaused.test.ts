// @vitest-environment node

/**
 * Paused hooks must outlive a restart. Each store keeps its data as JSON
 * text, the way electron-store keeps a file, and a fresh copy of the store
 * module reads it back, as the app does on its next launch.
 */

import { beforeEach, expect, it, vi } from 'vitest';

import type { PausedHook } from '../../../shared/hookEditor/hookDocument';

const { disk } = vi.hoisted(() => ({ disk: {} as Record<string, string> }));

vi.mock('electron-store', () => ({
  default: class DiskStore {
    private readonly name: string;
    constructor(options: { name?: string; defaults?: Record<string, unknown> } = {}) {
      this.name = options.name ?? 'config';
      disk[this.name] ??= JSON.stringify(options.defaults ?? {});
    }
    get path() {
      return `/mock/${this.name}.json`;
    }
    get store(): Record<string, unknown> {
      return JSON.parse(disk[this.name]);
    }
    get(key: string, fallback?: unknown) {
      const data = this.store;
      return key in data ? data[key] : fallback;
    }
    set(key: string, value: unknown) {
      disk[this.name] = JSON.stringify({ ...this.store, [key]: value });
    }
    delete(key: string) {
      const data = this.store;
      delete data[key];
      disk[this.name] = JSON.stringify(data);
    }
  },
}));

const USER_FILE = '/home/me/.claude/settings.json';
const PROJECT = '/work/app';
const LOCAL_FILE = '/work/app/.claude/settings.local.json';

function hook(command: string): PausedHook {
  return { event: 'Stop', matcher: null, entry: { type: 'command', command } };
}

async function launch() {
  vi.resetModules();
  return import('../store');
}

beforeEach(() => {
  for (const name of Object.keys(disk)) delete disk[name];
});

it('keeps paused hooks across a restart, in the right store, and drops a hook that was turned back on', async () => {
  const first = await launch();
  first.setAppPausedHooks(USER_FILE, [hook('echo a'), hook('echo b')]);
  first.setWorkspacePausedHooks(PROJECT, LOCAL_FILE, [hook('echo c')]);
  expect(first.getWorkspacePausedHooks('/work/other', LOCAL_FILE)).toEqual([]);

  const second = await launch();
  // The user file's list lives in app settings, so it reads the same in every project.
  expect(second.getAppPausedHooks(USER_FILE)).toEqual([hook('echo a'), hook('echo b')]);
  expect(second.getWorkspacePausedHooks(PROJECT, LOCAL_FILE)).toEqual([hook('echo c')]);
  second.setAppPausedHooks(USER_FILE, [hook('echo b')]);
  second.setWorkspacePausedHooks(PROJECT, LOCAL_FILE, []);

  const third = await launch();
  expect(third.getAppPausedHooks(USER_FILE)).toEqual([hook('echo b')]);
  expect(third.getWorkspacePausedHooks(PROJECT, LOCAL_FILE)).toEqual([]);
});
