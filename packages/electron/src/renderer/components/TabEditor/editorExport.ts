/**
 * Copy as Markdown and Export to PDF from a Lexical editor: the file header's
 * menu and every page header in Pages offer them.
 */
import type { LexicalEditor } from 'lexical';
import type { PageHeaderMenuItem } from '@nimbalyst/collab-client/trackers-ui/page';
import { $generateHtmlFromNodes } from '@lexical/html';
import { $convertToEnhancedMarkdownString, copyToClipboard, getEditorTransformers, wrapWithPrintStyles } from '@nimbalyst/runtime';

export function copyEditorAsMarkdown(editor: LexicalEditor): void {
  try {
    editor.getEditorState().read(() => {
      const markdown = $convertToEnhancedMarkdownString(getEditorTransformers());
      copyToClipboard(markdown).catch((err) => {
        console.error('[editorExport] Failed to copy markdown:', err);
      });
    });
  } catch (error) {
    console.error('[editorExport] Failed to convert to markdown:', error);
  }
}

/** Asks where to save, then prints the editor's HTML to a PDF there. */
export async function exportEditorToPdf(editor: LexicalEditor, fileName: string): Promise<void> {
  const electronAPI = (window as any).electronAPI;
  if (!electronAPI) return;
  try {
    const defaultPath = /\.(md|markdown|txt)$/i.test(fileName) ? fileName.replace(/\.(md|markdown|txt)$/i, '.pdf') : `${fileName}.pdf`;
    const outputPath = await electronAPI.showSaveDialogPdf({ defaultPath });
    if (!outputPath) return;

    let html = '';
    editor.getEditorState().read(() => {
      html = wrapWithPrintStyles($generateHtmlFromNodes(editor), fileName);
    });

    const result = await electronAPI.exportHtmlToPdf({
      html,
      outputPath,
      pageSize: 'Letter',
      generateDocumentOutline: true,
      generateTaggedPDF: true,
    });
    if (!result.success) {
      console.error('[editorExport] PDF export failed:', result.error);
      electronAPI.showErrorDialog('Export Failed', `Failed to export PDF: ${result.error}`);
    }
  } catch (error) {
    console.error('[editorExport] Failed to export to PDF:', error);
  }
}

/** The two as page header menu entries; none until the editor exists. */
export function editorExportMenuItems(editor: LexicalEditor | null, fileName: string): PageHeaderMenuItem[] {
  if (!editor) return [];
  return [
    { id: 'copy-markdown', label: 'Copy as Markdown', icon: 'content_copy', onSelect: () => copyEditorAsMarkdown(editor) },
    { id: 'export-pdf', label: 'Export to PDF...', icon: 'picture_as_pdf', onSelect: () => { void exportEditorToPdf(editor, fileName); } },
  ];
}
