// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

vi.mock('../../file/WorkspaceEventBus', () => ({
  subscribe: vi.fn().mockResolvedValue(undefined),
  unsubscribe: vi.fn(),
}));

import { ActionPromptService } from '../ActionPromptService';

describe('ActionPromptService', () => {
  let workspacePath: string;
  let actionsFile: string;

  beforeEach(() => {
    workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'action-prompts-svc-'));
    actionsFile = path.join(workspacePath, 'nimbalyst-local', 'ai-actions.md');
  });

  afterEach(() => {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  });

  it('returns fileExists=false and an empty list when the file is missing', async () => {
    const service = new ActionPromptService(workspacePath);
    const result = await service.list();
    expect(result.fileExists).toBe(false);
    expect(result.actions).toEqual([]);
    expect(result.filePath).toBe(actionsFile);
  });

  it('rereads edits and deletion when native events are missed (#1524)', async () => {
    fs.mkdirSync(path.dirname(actionsFile), { recursive: true });
    fs.writeFileSync(actionsFile, '## First\nbody one\n', 'utf8');

    const service = new ActionPromptService(workspacePath);
    const first = await service.list();
    expect(first.actions).toHaveLength(1);
    expect(first.actions[0].label).toBe('First');

    // No watcher callback: an edit during watcher downtime must still be visible.
    fs.writeFileSync(actionsFile, '## Second\nbody two\n', 'utf8');
    const fresh = await service.list();
    expect(fresh.actions).toHaveLength(1);
    expect(fresh.actions[0].label).toBe('Second');
    fs.unlinkSync(actionsFile);
    expect((await service.list()).fileExists).toBe(false);
  });

  it('reasserts its subscription on list after the bus loses subscribers', async () => {
    const bus = await import('../../file/WorkspaceEventBus');
    const service = new ActionPromptService(workspacePath);
    await service.list();
    vi.mocked(bus.subscribe).mockClear();
    await service.list();
    expect(bus.subscribe).toHaveBeenCalledTimes(1);
    await service.dispose();
  });

  it('does not report a read error as a missing file and recovers on the next read', async () => {
    fs.mkdirSync(actionsFile, { recursive: true });
    const service = new ActionPromptService(workspacePath);
    await expect(service.list()).rejects.toThrow();
    fs.rmdirSync(actionsFile);
    fs.writeFileSync(actionsFile, '## Recovered\nUsable again.\n');
    expect((await service.list()).actions[0].label).toBe('Recovered');
    await service.dispose();
  });

  it('ensureFileExists() seeds the default template when the file is missing', async () => {
    const service = new ActionPromptService(workspacePath);
    const filePath = await service.ensureFileExists();
    expect(filePath).toBe(actionsFile);
    const content = await fsp.readFile(filePath, 'utf8');
    expect(content).toContain('## Review Changed Files');
    expect(content).toContain('## Plan Implementation');
  });

  it('ensureFileExists() leaves an existing file untouched', async () => {
    fs.mkdirSync(path.dirname(actionsFile), { recursive: true });
    fs.writeFileSync(actionsFile, '## Existing\ncustom body\n', 'utf8');

    const service = new ActionPromptService(workspacePath);
    await service.ensureFileExists();
    const content = await fsp.readFile(actionsFile, 'utf8');
    expect(content).toBe('## Existing\ncustom body\n');
  });

  it('notifies change listeners on workspace fs events', async () => {
    fs.mkdirSync(path.dirname(actionsFile), { recursive: true });
    fs.writeFileSync(actionsFile, '## Original\noriginal body\n', 'utf8');

    const bus = await import('../../file/WorkspaceEventBus');
    const service = new ActionPromptService(workspacePath);
    const listener = vi.fn();
    service.onChange(listener);

    await service.list();
    expect(bus.subscribe).toHaveBeenCalled();

    // Pull the listener registration the service handed to the bus.
    const subscribeCall = (bus.subscribe as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
    const wsListener = subscribeCall[2];

    fs.writeFileSync(actionsFile, '## Updated\nupdated body\n', 'utf8');
    wsListener.onChange(actionsFile);

    expect(listener).toHaveBeenCalledTimes(1);

    const after = await service.list();
    expect(after.actions[0].label).toBe('Updated');
  });
});
