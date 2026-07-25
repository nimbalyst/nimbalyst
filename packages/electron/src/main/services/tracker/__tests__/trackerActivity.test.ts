import { describe, expect, it } from 'vitest';
import { appendActivity } from '../trackerActivity';

describe('appendActivity', () => {
  it('migrates legacy nested activity before appending', () => {
    const data: Record<string, any> = {
      customFields: {
        activity: [{ id: 'old', authorIdentity: { displayName: 'Alice' }, action: 'created', timestamp: 1 }],
        sibling: 'keep',
      },
    };

    appendActivity(data, { displayName: 'Alice' }, 'commented');

    expect(data.activity).toHaveLength(2);
    expect(data.activity[0].id).toBe('old');
    expect(data.activity[1].action).toBe('commented');
    expect(data.customFields).toEqual({ sibling: 'keep' });
  });
});
