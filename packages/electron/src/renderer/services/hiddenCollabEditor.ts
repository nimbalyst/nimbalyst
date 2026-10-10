/**
 * The editor for a shared page (a `collab://` URI), prepared for an agent's
 * extension tool when no tab has the page open (NIM-7397). It binds to the same
 * replica `readCollabDoc` reads, through the host a shared-page tab builds, so
 * `excalidraw_add_elements` and every other extension tool edit the page
 * itself rather than a file on disk. Registered at 'hidden' priority: an open
 * tab of the same page keeps the API.
 */
import type React from 'react';
import type { EditorAPIOwnerToken, EditorHost } from '@nimbalyst/runtime';
import { store, themeIdAtom } from '@nimbalyst/runtime/store';
import { customEditorRegistry } from '../components/CustomEditors';
import { resolveCollabEditorAvailability } from '../components/TabEditor/collabEditorAvailability';
import { createCollabExtensionHost, hasContentFlush } from '../components/TabEditor/collabExtensionHost';
import { acquireHeadlessCollabDocument, assertDecodable } from './HeadlessCollabDocument';

export interface HiddenCollabEditor {
  host: EditorHost;
  component: React.ComponentType<{ host: EditorHost }>;
  extensionId: string;
  /** True once the editor's binding has registered its pending-content flush. */
  isBound(): boolean;
  release(): void;
}

export async function prepareHiddenCollabEditor(
  uri: string,
  workspacePath: string,
  editorAPIOwnerToken: EditorAPIOwnerToken,
): Promise<HiddenCollabEditor> {
  const acquisition = await acquireHeadlessCollabDocument(uri, workspacePath);
  try {
    assertDecodable(acquisition, uri);
    const { document, documentType, collaboration, collabConfig } = acquisition;
    const fileExtension = document.fileExtension ?? undefined;
    const availability = resolveCollabEditorAvailability({
      documentType,
      fileName: `${document.title}${fileExtension ?? ''}`,
      fileExtension,
      title: document.title,
      editorId: document.editorId ?? undefined,
      findRegistration: (name) => customEditorRegistry.findRegistrationForFile(name),
    });
    if (availability.kind !== 'ready') {
      throw new Error(availability.kind === 'extension-missing'
        ? `No installed extension edits "${document.title}" (${documentType}).`
        : `The installed extension cannot edit the shared page "${document.title}".`);
    }
    const host = createCollabExtensionHost({
      filePath: uri,
      fileName: `${document.title}${fileExtension ?? ''}`,
      isActive: false,
      workspaceId: workspacePath,
      activeConfig: collabConfig,
      collaboration,
      getTheme: () => store.get(themeIdAtom),
      editorAPIPriority: 'hidden',
      editorAPIOwnerToken,
    });
    return {
      host,
      component: availability.registration.component as React.ComponentType<{ host: EditorHost }>,
      extensionId: availability.registration.extensionId ?? document.editorId ?? documentType,
      isBound: () => hasContentFlush(collaboration),
      release: () => acquisition.release(),
    };
  } catch (error) {
    acquisition.release();
    throw error;
  }
}
