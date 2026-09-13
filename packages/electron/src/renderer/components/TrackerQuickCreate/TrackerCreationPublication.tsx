import React, { useEffect, useState } from 'react';
import { atom, useAtom, useStore } from 'jotai';
import type { Store } from 'jotai/vanilla/store';
import type { TrackerCreationPublication as Publication } from '@nimbalyst/runtime/core/trackerCreation';
import { atomFamily } from '../../store/debug/atomFamilyRegistry';

export const creationPublicationAtom = atomFamily((_key: string) =>
  atom<{ value: Publication | null; busy: boolean }>({
    value: null,
    busy: false,
  }),
);
export const creationPublicationKey = (workspace: string, itemId: string) =>
  JSON.stringify([workspace, itemId]);

export async function publishCreatedTrackerItem(
  store: Store,
  workspacePath: string,
  itemId: string,
): Promise<void> {
  const target = creationPublicationAtom(
    creationPublicationKey(workspacePath, itemId),
  );
  if (store.get(target).busy) return;
  const savedContent = store.get(target).value?.savedContent;
  store.set(target, {
    value: { itemId, status: 'pending', savedContent },
    busy: true,
  });
  try {
    const value =
      await window.electronAPI.documentService.publishTrackerCreation({
        workspacePath,
        itemId,
      });
    store.set(target, {
      value: value.status === 'pending' ? { ...value, savedContent } : value,
      busy: false,
    });
  } catch (error) {
    store.set(target, {
      value: {
        itemId,
        status: 'pending',
        savedContent,
        error: error instanceof Error ? error.message : String(error),
      },
      busy: false,
    });
  }
}

export function TrackerCreationPublication({
  workspacePath,
  itemId,
}: {
  workspacePath: string;
  itemId: string;
}) {
  const store = useStore();
  const target = creationPublicationAtom(
    creationPublicationKey(workspacePath, itemId),
  );
  const [state, setState] = useAtom(target);
  const [copyError, setCopyError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const initialState = store.get(target);
    window.electronAPI.documentService
      .getTrackerCreationStatus({ workspacePath, itemId })
      .then((value) => {
        if (
          !cancelled &&
          store.get(target) === initialState &&
          !initialState.busy
        )
          setState({ value, busy: false });
      })
      .catch((error) => {
        if (!cancelled)
          console.error(
            '[TrackerCreation] Could not read publication status:',
            error,
          );
      });
    return () => {
      cancelled = true;
    };
  }, [workspacePath, itemId, store, target, setState]);
  if (state.value?.status !== 'pending') return null;
  return (
    <div
      className="tracker-creation-publication flex flex-wrap items-center gap-2 text-xs text-nim-muted"
      role="status"
    >
      <span className="select-text">
        {state.busy
          ? 'Publishing to team…'
          : state.value.error || 'Saved locally; team publication is pending.'}
      </span>
      {!state.busy && (
        <button
          type="button"
          className="text-nim-link"
          onClick={() =>
            void publishCreatedTrackerItem(store, workspacePath, itemId)
          }
        >
          Retry publication
        </button>
      )}
      {!state.busy && state.value.savedContent && (
        <button
          type="button"
          className="text-nim-link"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(
                state.value?.savedContent ?? '',
              );
              setCopyError(null);
            } catch (error) {
              setCopyError(
                error instanceof Error ? error.message : String(error),
              );
            }
          }}
        >
          Copy saved content
        </button>
      )}
      {copyError && (
        <span role="alert" className="text-nim-error">
          {copyError}
        </span>
      )}
    </div>
  );
}
