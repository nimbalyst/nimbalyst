// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import { afterEach, expect, it, vi } from 'vitest';
import {
  creationPublicationAtom,
  creationPublicationKey,
  publishCreatedTrackerItem,
  TrackerCreationPublication,
} from '../TrackerCreationPublication';
afterEach(cleanup);
it('does not replace successful publication with an older pending-status response', async () => {
  let finishStatus!: (value: unknown) => void;
  const publish = vi
    .fn()
    .mockResolvedValue({ itemId: 'item', status: 'published' });
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      documentService: {
        getTrackerCreationStatus: () =>
          new Promise((resolve) => {
            finishStatus = resolve;
          }),
        publishTrackerCreation: publish,
      },
    },
  });
  const store = createStore();
  const target = creationPublicationAtom(
    creationPublicationKey('/test', 'item'),
  );
  render(
    <Provider store={store}>
      <TrackerCreationPublication workspacePath="/test" itemId="item" />
    </Provider>,
  );
  await act(async () => {
    await publishCreatedTrackerItem(store, '/test', 'item');
  });
  await act(async () =>
    finishStatus({
      itemId: 'item',
      status: 'pending',
      savedContent: 'Old snapshot',
    }),
  );
  expect(store.get(target)).toEqual({
    busy: false,
    value: { itemId: 'item', status: 'published' },
  });
});
