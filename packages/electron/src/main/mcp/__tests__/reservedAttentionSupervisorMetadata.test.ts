import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  updateMetadata: vi.fn().mockResolvedValue(undefined),
  get: vi.fn().mockResolvedValue({ id: 'session-1', title: 'Session 1', metadata: {} }),
  namingUpdate: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@nimbalyst/runtime', () => ({
  AISessionsRepository: {
    updateMetadata: mocks.updateMetadata,
    get: mocks.get,
  },
  SessionFilesRepository: {},
}));

import { ATTENTION_SUPERVISOR_METADATA_KEY } from '../../services/AttentionSupervisorAuthorization';
import {
  dispatchSessionMetaTool,
  setGetSessionPhaseFn,
  setGetSessionTagsFn,
  setGetSessionTitleFn,
  setUpdateSessionMetadataFn,
} from '../sessionNamingServer';
import { dispatchSessionContextTool } from '../sessionContextServer';

describe('agent/MCP reserved attention-supervisor metadata audit', () => {
  beforeEach(() => {
    mocks.updateMetadata.mockClear();
    mocks.namingUpdate.mockClear();
    setUpdateSessionMetadataFn(mocks.namingUpdate);
    setGetSessionTitleFn(async () => 'Session 1');
    setGetSessionTagsFn(async () => []);
    setGetSessionPhaseFn(async () => 'implementing');
  });

  it('rejects a reserved-key attempt at update_session_meta before its injected writer', async () => {
    await expect(dispatchSessionMetaTool('update_session_meta', {
      phase: 'validating',
      nested: { [ATTENTION_SUPERVISOR_METADATA_KEY]: ['agent-session'] },
    }, 'session-1')).rejects.toThrow(/reserved.*dedicated/i);
    expect(mocks.namingUpdate).not.toHaveBeenCalled();
  });

  it('rejects a reserved-key attempt at update_session_board before repository write', async () => {
    const result = await dispatchSessionContextTool('update_session_board', {
      sessionId: 'session-1',
      phase: 'validating',
      [ATTENTION_SUPERVISOR_METADATA_KEY]: null,
    }, 'agent-session', '/workspace');

    expect(result).toMatchObject({ isError: true });
    expect(result.content[0]?.text).toMatch(/reserved.*dedicated/i);
    expect(mocks.updateMetadata).not.toHaveBeenCalled();
  });

  it('keeps the allowlisted MCP metadata fields working', async () => {
    await expect(dispatchSessionMetaTool('update_session_meta', {
      phase: 'validating',
    }, 'session-1')).resolves.toMatchObject({ isError: false });
    expect(mocks.namingUpdate).toHaveBeenCalledWith('session-1', { phase: 'validating' });
  });
});
