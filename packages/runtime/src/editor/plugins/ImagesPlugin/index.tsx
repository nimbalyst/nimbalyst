/**
 * Images plugin module: exports the insert-image dialogs and re-exports
 * the node, transformer, and command identity. The runtime registrations
 * (command handler, drag/drop wiring) live in
 * `editor/extensions/builtin/ImagesExtension.ts`.
 *
 * The plugin still tracks host callbacks (`onImageDoubleClick`, etc.) in a
 * module-level slot read by `ImageComponent`. Hosts (TabEditor / file
 * preview surfaces) call `setImagePluginCallbacks` once at mount so the
 * extension's command handler doesn't need to receive props.
 */

import type { JSX } from 'react';

export { IMAGE_TRANSFORMER } from './ImageTransformer';
export { ImageNode, $createImageNode, $isImageNode } from './ImageNode';
export type { ImagePayload, SerializedImageNode } from './ImageNode';
export { INSERT_IMAGE_COMMAND, type InsertImagePayload } from './ImageCommands';

import { useEffect, useRef, useState } from 'react';
import type { LexicalEditor, NodeKey } from 'lexical';

import { INSERT_IMAGE_COMMAND, type InsertImagePayload } from './ImageCommands';
import Button from '../../ui/Button';
import { DialogActions, DialogButtonsList } from '../../ui/Dialog';
import FileInput from '../../ui/FileInput';
import TextInput from '../../ui/TextInput';

let imagePluginCallbacks: {
  onImageDoubleClick?: (src: string, nodeKey: NodeKey) => void;
  onImageDragStart?: (src: string, event: DragEvent) => void;
  onUploadAsset?: (file: File) => Promise<{ kind: 'image' | 'file'; src: string; altText?: string }>;
  resolveImageSrc?: (src: string) => Promise<string | null>;
} = {};

export function getImagePluginCallbacks() {
  return imagePluginCallbacks;
}

export function setImagePluginCallbacks(
  callbacks: typeof imagePluginCallbacks,
): void {
  imagePluginCallbacks = callbacks;
}

export function InsertImageUriDialogBody({
  onClick,
}: {
  onClick: (payload: InsertImagePayload) => void;
}) {
  const [src, setSrc] = useState('');
  const [altText, setAltText] = useState('');
  const isDisabled = src === '';
  return (
    <>
      <TextInput
        label="Image URL"
        placeholder="i.e. https://source.unsplash.com/random"
        onChange={setSrc}
        value={src}
        data-test-id="image-modal-url-input"
      />
      <TextInput
        label="Alt Text"
        placeholder="Random unsplash image"
        onChange={setAltText}
        value={altText}
        data-test-id="image-modal-alt-text-input"
      />
      <DialogActions>
        <Button
          data-test-id="image-modal-confirm-btn"
          disabled={isDisabled}
          onClick={() => onClick({ altText, src })}
        >
          Confirm
        </Button>
      </DialogActions>
    </>
  );
}

export function InsertImageUploadedDialogBody({
  onClick,
}: {
  onClick: (payload: InsertImagePayload) => void;
}) {
  const [src, setSrc] = useState('');
  const [altText, setAltText] = useState('');
  const isDisabled = src === '';

  const loadImage = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const file = files[0];

    const callbacks = getImagePluginCallbacks();
    if (callbacks.onUploadAsset) {
      try {
        const uploaded = await callbacks.onUploadAsset(file);
        if (uploaded.kind !== 'image') {
          throw new Error('Expected image upload result');
        }
        setSrc(uploaded.src);
        if (!altText) {
          setAltText(uploaded.altText ?? file.name);
        }
        return;
      } catch (error) {
        console.error('Failed to upload image asset:', error);
      }
    }

    if (typeof window !== 'undefined' && (window as { electronAPI?: unknown }).electronAPI) {
      try {
        const arrayBuffer = await file.arrayBuffer();
        const buffer = Array.from(new Uint8Array(arrayBuffer));
        const documentPath = (window as { __currentDocumentPath?: string }).__currentDocumentPath;
        const electronAPI = (window as unknown as {
          electronAPI: { invoke: (channel: string, args: unknown) => Promise<{ relativePath: string }> };
        }).electronAPI;
        const { relativePath } = await electronAPI.invoke('document-service:store-asset', {
          buffer,
          mimeType: file.type,
          documentPath,
        });
        setSrc(relativePath);
      } catch (error) {
        console.error('Failed to store asset:', error);
        fallbackToBase64(file);
      }
    } else {
      fallbackToBase64(file);
    }
  };

  const fallbackToBase64 = (file: File) => {
    const reader = new FileReader();
    reader.onload = function () {
      if (typeof reader.result === 'string') {
        setSrc(reader.result);
      }
    };
    reader.readAsDataURL(file);
  };

  return (
    <>
      <FileInput
        label="Image Upload"
        onChange={loadImage}
        accept="image/*"
        data-test-id="image-modal-file-upload"
      />
      <TextInput
        label="Alt Text"
        placeholder="Descriptive alternative text"
        onChange={setAltText}
        value={altText}
        data-test-id="image-modal-alt-text-input"
      />
      <DialogActions>
        <Button
          data-test-id="image-modal-file-upload-btn"
          disabled={isDisabled}
          onClick={() => onClick({ altText, src })}
        >
          Confirm
        </Button>
      </DialogActions>
    </>
  );
}

export function InsertImageDialog({
  activeEditor,
  onClose,
}: {
  activeEditor: LexicalEditor;
  onClose: () => void;
}): JSX.Element {
  const [mode, setMode] = useState<null | 'url' | 'file'>(null);
  const hasModifier = useRef(false);

  useEffect(() => {
    hasModifier.current = false;
    const handler = (e: KeyboardEvent) => {
      hasModifier.current = e.altKey;
    };
    document.addEventListener('keydown', handler);
    return () => {
      document.removeEventListener('keydown', handler);
    };
  }, [activeEditor]);

  const onClick = (payload: InsertImagePayload) => {
    activeEditor.dispatchCommand(INSERT_IMAGE_COMMAND, payload);
    onClose();
  };

  return (
    <>
      {!mode && (
        <DialogButtonsList>
          <Button data-test-id="image-modal-option-url" onClick={() => setMode('url')}>
            URL
          </Button>
          <Button data-test-id="image-modal-option-file" onClick={() => setMode('file')}>
            File
          </Button>
        </DialogButtonsList>
      )}
      {mode === 'url' && <InsertImageUriDialogBody onClick={onClick} />}
      {mode === 'file' && <InsertImageUploadedDialogBody onClick={onClick} />}
    </>
  );
}
