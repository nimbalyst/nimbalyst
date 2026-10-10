/**
 * Desktop host for the code excerpt block's "Open file": opens the tab, then
 * scrolls it to the quoted line once the editor mounts (`revealEditorPosition`
 * holds the request until then). Reading the file needs no host here; the
 * block uses the `code-excerpt:read` channel directly.
 */

import { setCodeExcerptCallbacks } from '@nimbalyst/runtime/editor/plugins/CodeExcerptPlugin/CodeExcerptCallbacks';

import { revealEditorPosition } from '../components/TabEditor/editorRevealCommand';

export function registerCodeExcerptHost(): void {
  setCodeExcerptCallbacks({
    openFileAtLine: (absolutePath, line) => {
      const workspacePath = (window as unknown as { __workspacePath?: string }).__workspacePath;
      if (!workspacePath) return;
      revealEditorPosition(absolutePath, { line });
      void window.electronAPI.invoke('workspace:open-file', { workspacePath, filePath: absolutePath });
    },
  });
}
