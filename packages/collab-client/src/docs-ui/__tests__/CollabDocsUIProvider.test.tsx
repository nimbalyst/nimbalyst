// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import type { CollabDocsSession } from '@nimbalyst/collab-client/docs';
import { CollabDocsUIProvider, useCollabDocsUI } from '../CollabDocsUIProvider';

describe('CollabDocsUIProvider', () => {
  it('does not re-render context consumers when the host re-renders with the same session', () => {
    const session = { scope: { scopeKey: '/provider-test' }, host: {} } as unknown as CollabDocsSession;
    let consumerRenders = 0;
    const Consumer = React.memo(function Consumer() {
      useCollabDocsUI();
      consumerRenders++;
      return null;
    });

    const { rerender } = render(<CollabDocsUIProvider session={session}><Consumer /></CollabDocsUIProvider>);
    rerender(<CollabDocsUIProvider session={session}><Consumer /></CollabDocsUIProvider>);
    rerender(<CollabDocsUIProvider session={session}><Consumer /></CollabDocsUIProvider>);

    expect(consumerRenders).toBe(1);
  });
});
