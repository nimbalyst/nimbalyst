// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { provisionalTitleForFirstMessage } from '../provisionalSessionTitle';

describe('provisionalTitleForFirstMessage', () => {
  const prompt = `[Shift] Mon, Sep 28\nWoken by the user: ${'x'.repeat(120)}`;

  it('titles an unnamed session from its first message, truncated', () => {
    const title = provisionalTitleForFirstMessage({ hasBeenNamed: false, messages: [] }, prompt);
    expect(title).toHaveLength(100);
    expect(title?.endsWith('...')).toBe(true);
    expect(provisionalTitleForFirstMessage({ messages: [{ type: 'user_message' }] }, 'hi')).toBe('hi');
  });

  it('keeps an explicit title given at creation', () => {
    expect(provisionalTitleForFirstMessage({ hasBeenNamed: true, messages: [] }, prompt)).toBeNull();
  });

  it('leaves a session that already has a conversation alone', () => {
    expect(provisionalTitleForFirstMessage({ messages: [{ type: 'user_message' }, { type: 'assistant_message' }] }, prompt)).toBeNull();
  });
});
