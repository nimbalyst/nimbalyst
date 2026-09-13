// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
const { handlers, getOverrides } = vi.hoisted(() => ({ handlers: new Map<string, Function>(), getOverrides: vi.fn() }));
vi.mock('../../../../utils/ipcRegistry', () => ({ safeHandle: (name: string, handler: Function) => handlers.set(name, handler) }));
vi.mock('../../../../utils/store', () => ({ getAIProviderOverrides: getOverrides }));
vi.mock('../../../../utils/workspaceDetection', () => ({ resolveProjectPath: (p: string) => p }));
vi.mock('../../../credentials/providerCredentials', () => ({ getProviderCredentials: () => ({ availableKeys: () => ({}) }) }));
import { registerProjectSettingsHandlers } from '../registerProjectSettingsHandlers';

describe('#1476 effective runtime settings IPC', () => {
  it.each([
    [undefined, undefined, '/global/claude'],
    ['/project', undefined, '/global/claude'],
    ['/project', '/project/claude', '/project/claude'],
    ['/project', '', ''],
  ])('merges global and project paths for %s / %s', async (workspace, override, expected) => {
    getOverrides.mockReturnValue(override === undefined ? undefined : { customClaudeCodePath: override });
    registerProjectSettingsHandlers({
      getSettingsStore: () => ({ get: (key: string, fallback: unknown) => key === 'customClaudeCodePath' ? '/global/claude' : fallback }),
      maskApiKeys: (keys: unknown) => keys,
    } as any);
    const result = await handlers.get('ai:getEffectiveSettings')!({}, workspace);
    expect(result.success).toBe(true);
    expect(result.settings.customClaudeCodePath).toBe(expected);
  });
});
