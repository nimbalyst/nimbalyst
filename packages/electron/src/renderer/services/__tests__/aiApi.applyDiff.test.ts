import { beforeAll, describe, expect, it, vi } from 'vitest';

const applyAgentDiff = vi.fn(async () => ({ success: true }));
vi.mock('../agentDocumentAccess', () => ({ applyAgentDiff }));
vi.mock('../../utils/logger', () => ({
  logger: { api: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

type ApplyDiffHandler = (data: Record<string, unknown>) => Promise<void>;
let onApplyDiff: ApplyDiffHandler | null = null;
const sendMcpApplyDiffResult = vi.fn();

beforeAll(async () => {
  // Every `on*` subscription the constructor makes is a no-op except applyDiff.
  const electronAPI = new Proxy({} as Record<string, unknown>, {
    get: (_target, key: string) => {
      if (key === 'onAIApplyDiff') return (handler: ApplyDiffHandler) => { onApplyDiff = handler; };
      if (key === 'sendMcpApplyDiffResult') return sendMcpApplyDiffResult;
      return vi.fn();
    },
  });
  (globalThis as { window?: unknown }).window = { electronAPI };
  await import('../aiApi');
});

describe('aiApi applyDiff', () => {
  it("routes an edit without a workspace path through the window's workspace, so the other-project check runs", async () => {
    const { store } = await import('@nimbalyst/runtime/store');
    const { activeWorkspacePathAtom } = await import('../../store/atoms/openProjects');
    store.set(activeWorkspacePathAtom, '/ws/project-a');

    await onApplyDiff!({
      replacements: [{ oldText: 'a', newText: 'b' }],
      resultChannel: 'result-1',
      targetFilePath: 'collab://org:o1:doc:page-b',
    });

    expect(applyAgentDiff).toHaveBeenCalledWith(
      'collab://org:o1:doc:page-b',
      [{ oldText: 'a', newText: 'b' }],
      { workspacePath: '/ws/project-a' },
    );
  });
});
