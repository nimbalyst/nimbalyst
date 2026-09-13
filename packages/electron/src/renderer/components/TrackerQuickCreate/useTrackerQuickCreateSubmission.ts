import { useCallback } from 'react';
import { useStore, type PrimitiveAtom } from 'jotai';
import {
  buildTrackerCreatePayload,
  formatTrackerValidationErrors,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/models/trackerCreatePayload';
import { globalRegistry } from '@nimbalyst/runtime/plugins/TrackerPlugin/models/TrackerDataModel';
import {
  createEmptyTrackerQuickCreateDraft,
  type TrackerQuickCreateDraft,
} from '../../store/atoms/trackerQuickCreate';
import {
  carryStickyValues,
  stickyQuickCreateFieldNames,
} from './trackerQuickCreateFields';
import {
  creationPublicationAtom,
  creationPublicationKey,
  publishCreatedTrackerItem,
} from './TrackerCreationPublication';

export function useTrackerQuickCreateSubmission(
  workspacePath: string | null,
  draftAtom: PrimitiveAtom<TrackerQuickCreateDraft>,
  onCreated: (id: string, closeAfter: boolean) => void,
) {
  const store = useStore();
  return useCallback(
    async (closeAfter: boolean) => {
      const draft = store.get(draftAtom);
      if (
        !workspacePath ||
        !draft.type ||
        !draft.title.trim() ||
        draft.submitting
      )
        return;
      if (
        draft.pendingImages ||
        draft.stagedImages.length ||
        draft.failedImages.length
      ) {
        store.set(draftAtom, {
          ...draft,
          error:
            'Finish adding screenshots, or remove failed images, before creating the item.',
        });
        return;
      }
      const built = buildTrackerCreatePayload(
        draft.type,
        {
          title: draft.title,
          content: draft.description,
          fields: draft.fields,
          creationRequestId: draft.id,
        },
        { workspacePath, generateId: () => draft.id },
      );
      if (!built.ok) {
        store.set(draftAtom, {
          ...draft,
          error: formatTrackerValidationErrors(built.errors),
        });
        return;
      }
      store.set(draftAtom, { ...draft, submitting: true, error: null });
      try {
        const result =
          await window.electronAPI.documentService.createTrackerItem(
            built.payload,
          );
        if (!result.success)
          throw new Error(result.error || 'Could not create the item');
        const current = store.get(draftAtom);
        // A result for an old draft must never clear another workspace/type's input.
        if (current.id === draft.id) {
          const sticky = carryStickyValues(
            draft.fields,
            stickyQuickCreateFieldNames(
              draft.type,
              globalRegistry.get(draft.type),
            ),
          );
          store.set(draftAtom, {
            ...createEmptyTrackerQuickCreateDraft(),
            type: draft.type,
            fields: sticky.values,
            carriedFields: sticky.carried,
            recentTypes: [
              draft.type,
              ...draft.recentTypes.filter((type) => type !== draft.type),
            ],
          });
        }
        if (result.publication) {
          store.set(
            creationPublicationAtom(
              creationPublicationKey(workspacePath, draft.id),
            ),
            { value: result.publication, busy: false },
          );
          if (result.publication.status === 'pending')
            void publishCreatedTrackerItem(store, workspacePath, draft.id);
        }
        onCreated(draft.id, closeAfter && current.id === draft.id);
      } catch (error) {
        store.set(draftAtom, (current) =>
          current.id === draft.id
            ? {
                ...current,
                submitting: false,
                error: error instanceof Error ? error.message : String(error),
              }
            : current,
        );
      }
    },
    [workspacePath, draftAtom, store, onCreated],
  );
}
