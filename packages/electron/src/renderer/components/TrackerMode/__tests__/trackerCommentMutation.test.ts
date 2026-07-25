import { describe, expect, it, vi } from 'vitest';
import { invokeTrackerCommentMutation } from '../trackerCommentMutation';

describe('invokeTrackerCommentMutation', () => {
  it('returns successful backend results', async () => {
    const invoke = vi.fn().mockResolvedValue({ success: true, commentId: 'comment-1' });

    await expect(invokeTrackerCommentMutation(invoke, 'tracker:add', { body: 'hello' }))
      .resolves.toEqual({ success: true, commentId: 'comment-1' });
  });

  it('turns backend success:false results into actionable failures', async () => {
    const invoke = vi.fn().mockResolvedValue({ success: false, error: 'Item not found' });

    await expect(invokeTrackerCommentMutation(invoke, 'tracker:add', { body: 'hello' }))
      .rejects.toThrow('Item not found');
  });
});
