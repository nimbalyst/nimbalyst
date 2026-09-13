import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useAtomValue, useStore, type PrimitiveAtom } from 'jotai';
import {
  COMMAND_PRIORITY_HIGH,
  KEY_ENTER_COMMAND,
  type LexicalEditor,
} from 'lexical';
import { NimbalystEditor } from '@nimbalyst/runtime/editor/NimbalystEditor';
import type {
  EditorConfig,
  UploadedEditorAsset,
} from '@nimbalyst/runtime/editor/EditorConfig';
import { INSERT_IMAGE_COMMAND } from '@nimbalyst/runtime/editor/plugins/ImagesPlugin/ImageCommands';
import { MAX_COLLAB_ASSET_BYTES } from '@nimbalyst/runtime/sync/collabAssetFormat';
import type { TrackerQuickCreateDraft } from '../../store/atoms/trackerQuickCreate';
import { nimAssetUrl } from '../../utils/assetUrl';
import './TrackerQuickCreateEditor.css';

/**
 * A stage request with no reply would otherwise hold `pendingImages` above zero
 * for the life of the draft, which survives dismiss and reopen, so submit would
 * stay blocked until reload. Past this bound the image becomes a failed row with
 * its own Retry and Remove.
 */
export const IMAGE_STAGE_TIMEOUT_MS = 60_000;

function withStageTimeout<T>(request: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    request.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('Screenshot staging timed out. Retry the image.')),
        IMAGE_STAGE_TIMEOUT_MS,
      );
    }),
  ]);
}

export const TrackerQuickCreateEditor = React.memo(
  function TrackerQuickCreateEditor({
    workspacePath,
    draftId,
    draftAtom,
    onSubmit,
  }: {
    workspacePath: string;
    draftId: string;
    draftAtom: PrimitiveAtom<TrackerQuickCreateDraft>;
    /** Cmd/Ctrl+Enter inside the body; the popup decides what submitting means. */
    onSubmit?: () => void;
  }) {
    const store = useStore();
    const draft = useAtomValue(draftAtom);
    const initialContent = useRef(store.get(draftAtom).description);
    const getContent = useRef<(() => string) | null>(null);
    const [editor, setEditor] = useState<LexicalEditor | null>(null);
    const editorRef = useRef<LexicalEditor | null>(null);
    const submitRef = useRef(onSubmit);
    submitRef.current = onSubmit;
    const mounted = useRef(true);
    const imageInput = useRef<HTMLInputElement>(null);
    useEffect(() => {
      mounted.current = true;
      return () => {
        mounted.current = false;
      };
    }, []);

    // Lexical's rich-text plugin prevents default on every Enter, modifiers
    // included, and inserts a paragraph. Claim the modifier form first so the
    // popup's Cmd/Ctrl+Enter shortcut works from the body as well as the title.
    useEffect(
      () =>
        editor?.registerCommand<KeyboardEvent | null>(
          KEY_ENTER_COMMAND,
          (event) => {
            if (!event || !(event.metaKey || event.ctrlKey) || event.isComposing)
              return false;
            event.preventDefault();
            submitRef.current?.();
            return true;
          },
          COMMAND_PRIORITY_HIGH,
        ),
      [editor],
    );

    const upload = useMemo(
      () =>
        async (file: File): Promise<UploadedEditorAsset> => {
          const failureId = crypto.randomUUID();
          store.set(draftAtom, (current) =>
            current.id === draftId
              ? { ...current, pendingImages: current.pendingImages + 1 }
              : current,
          );
          try {
            if (
              !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(
                file.type,
              )
            )
              throw new Error('Use a PNG, JPEG, GIF, or WebP screenshot');
            if (!file.size || file.size > MAX_COLLAB_ASSET_BYTES)
              throw new Error('Screenshot must be between 1 byte and 25 MB');
            const result = await withStageTimeout(
              window.electronAPI.documentService.stageTrackerImage({
                workspacePath,
                bytes: await file.arrayBuffer(),
                mimeType: file.type,
              }),
            );
            if (!result.relativePath)
              throw new Error('Screenshot could not be saved');
            if (!mounted.current) {
              store.set(draftAtom, (current) =>
                current.id === draftId
                  ? {
                      ...current,
                      stagedImages: [
                        ...current.stagedImages,
                        {
                          src: result.relativePath,
                          altText: file.name.replace(/[\[\]\\\r\n]/g, ''),
                        },
                      ],
                    }
                  : current,
              );
            }
            return {
              kind: 'image',
              src: result.relativePath,
              altText: file.name.replace(/[\[\]\\\r\n]/g, ''),
            };
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            store.set(draftAtom, (current) =>
              current.id === draftId
                ? {
                    ...current,
                    failedImages: [
                      ...current.failedImages,
                      { id: failureId, file, error: message },
                    ],
                  }
                : current,
            );
            throw error;
          } finally {
            store.set(draftAtom, (current) =>
              current.id === draftId
                ? {
                    ...current,
                    pendingImages: Math.max(0, current.pendingImages - 1),
                  }
                : current,
            );
          }
        },
      [workspacePath, draftId, draftAtom, store],
    );

    const config = useMemo(
      (): EditorConfig => ({
        isRichText: true,
        editable: true,
        markdownOnly: true,
        showToolbar: false,
        forceFloatingToolbar: true,
        initialContent: initialContent.current,
        workspaceId: workspacePath,
        filePath: `${workspacePath.replace(
          /\\/g,
          '/',
        )}/.nimbalyst/tracker-drafts/${draftId}.md`,
        onGetContent: (get) => {
          getContent.current = get;
        },
        onEditorReady: (instance: LexicalEditor) => {
          editorRef.current = instance;
          setEditor(instance);
        },
        onUploadAsset: upload,
        resolveImageSrc: async (src) =>
          src.startsWith('.nimbalyst/assets/')
            ? nimAssetUrl(`${workspacePath.replace(/\\/g, '/')}/${src}`)
            : null,
      }),
      [workspacePath, draftId, draftAtom, store, upload],
    );

    useEffect(
      () =>
        editor?.registerUpdateListener(({ dirtyElements, dirtyLeaves }) => {
          if ((!dirtyElements.size && !dirtyLeaves.size) || !getContent.current)
            return;
          const markdown = getContent.current();
          store.set(draftAtom, (current) =>
            current.id === draftId && current.description !== markdown
              ? { ...current, description: markdown }
              : current,
          );
        }),
      [editor, draftAtom, draftId, store],
    );

    useEffect(() => {
      if (!editor || !draft.stagedImages.length) return;
      const images = draft.stagedImages;
      editor.update(
        () => {
          for (const asset of images)
            editor.dispatchCommand(INSERT_IMAGE_COMMAND, asset);
        },
        { discrete: true },
      );
      store.set(draftAtom, (current) =>
        current.id === draftId
          ? {
              ...current,
              stagedImages: current.stagedImages.filter(
                (image) => !images.includes(image),
              ),
              description: getContent.current?.() ?? current.description,
            }
          : current,
      );
    }, [editor, draft.stagedImages, draftAtom, draftId, store]);

    const insertFile = async (file: File) => {
      try {
        const asset = await upload(file);
        // Unmounted: `upload` already parked it in stagedImages for the next mount.
        if (!mounted.current) return;
        const image = { src: asset.src, altText: asset.altText ?? file.name };
        const target = editorRef.current;
        if (target) target.dispatchCommand(INSERT_IMAGE_COMMAND, image);
        else
          store.set(draftAtom, (current) =>
            current.id === draftId
              ? { ...current, stagedImages: [...current.stagedImages, image] }
              : current,
          );
      } catch {
        /* The retained failed-image row carries the error and retry. */
      }
    };

    return (
      <div
        className="tracker-quick-create-rich-content"
        data-testid="tracker-quick-create-description"
      >
        <div className="tracker-quick-create-rich-editor">
          <NimbalystEditor config={config} />
        </div>
        <div className="tracker-quick-create-image-actions flex items-center justify-between px-3 py-1 text-xs text-nim-muted">
          <button type="button" onClick={() => imageInput.current?.click()}>
            Add screenshot
          </button>
          <span>
            {draft.pendingImages
              ? 'Adding screenshot…'
              : 'Paste or drop screenshots into Content'}
          </span>
          <input
            data-testid="tracker-quick-create-image-input"
            ref={imageInput}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            hidden
            onChange={(event) => {
              for (const file of Array.from(event.target.files ?? []))
                void insertFile(file);
              event.target.value = '';
            }}
          />
        </div>
        {draft.failedImages.map((failure) => (
          <div
            className="tracker-quick-create-image-error flex items-center gap-2 px-3 py-1 text-xs text-nim-error"
            key={failure.id}
            role="alert"
          >
            <span className="select-text">
              {failure.file.name}: {failure.error}
            </span>
            <button
              type="button"
              onClick={() => {
                store.set(draftAtom, (current) => ({
                  ...current,
                  failedImages: current.failedImages.filter(
                    (image) => image.id !== failure.id,
                  ),
                }));
                void insertFile(failure.file);
              }}
            >
              Retry image
            </button>
            <button
              type="button"
              onClick={() =>
                store.set(draftAtom, (current) => ({
                  ...current,
                  failedImages: current.failedImages.filter(
                    (image) => image.id !== failure.id,
                  ),
                }))
              }
            >
              Remove
            </button>
          </div>
        ))}
      </div>
    );
  },
);
