// @vitest-environment jsdom

import React from 'react';
import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlansPanel } from '../PlansPanel';

vi.mock('../PlanListItem', () => ({
  PlanListItem: () => null,
}));

vi.mock('../PlanFilters', () => ({
  PlanFilters: () => null,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

describe('PlansPanel metadata subscription lifecycle', () => {
  afterEach(() => {
    delete (window as any).documentService;
  });

  it('does not install a watcher after unmount while metadata is loading', async () => {
    const metadata = deferred<[]>();
    const watchDocumentMetadata = vi.fn(() => vi.fn());
    (window as any).documentService = {
      listDocumentMetadata: vi.fn(() => metadata.promise),
      watchDocumentMetadata,
    };

    const view = render(
      <PlansPanel currentFilePath={null} onPlanSelect={vi.fn()} />,
    );
    view.unmount();

    await act(async () => {
      metadata.resolve([]);
      await metadata.promise;
    });

    expect(watchDocumentMetadata).not.toHaveBeenCalled();
  });

  it('unsubscribes an established watcher on unmount', async () => {
    const unsubscribe = vi.fn();
    (window as any).documentService = {
      listDocumentMetadata: vi.fn().mockResolvedValue([]),
      watchDocumentMetadata: vi.fn(() => unsubscribe),
    };

    const view = render(
      <PlansPanel currentFilePath={null} onPlanSelect={vi.fn()} />,
    );
    await act(async () => {
      await Promise.resolve();
    });

    view.unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
