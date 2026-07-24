import { $getRoot, $createParagraphNode, $createTextNode, $getSelection, $isRangeSelection, CLEAR_HISTORY_COMMAND } from 'lexical';

export interface EditRequest {
  type: 'edit' | 'insert' | 'delete' | 'replace' | 'append';
  range?: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
  content: string;
  preview?: boolean;
}

export class EditService {
  private editor: any;

  constructor(editor: any) {
    this.editor = editor;
  }

  /**
   * Apply an edit request to the Lexical editor
   */
  async applyEdit(edit: EditRequest): Promise<boolean> {
    if (!this.editor) {
      console.error('Editor not initialized');
      return false;
    }

    return new Promise((resolve) => {
      this.editor.update(() => {
        try {
          switch (edit.type) {
            case 'replace':
              this.replaceContent(edit.content);
              break;
            
            case 'append':
              this.appendContent(edit.content);
              break;
            
            case 'insert':
              if (edit.range) {
                this.insertAtPosition(edit.content, edit.range.start);
              } else {
                this.insertAtCursor(edit.content);
              }
              break;
            
            case 'delete':
              if (edit.range) {
                this.deleteRange(edit.range);
              }
              break;
            
            case 'edit':
              if (edit.range) {
                this.editRange(edit.range, edit.content);
              }
              break;
            
            default:
              console.error('Unknown edit type:', edit.type);
              resolve(false);
              return;
          }
          
          resolve(true);
        } catch (error) {
          console.error('Failed to apply edit:', error);
          resolve(false);
        }
      });
    });
  }

  /**
   * Replace entire document content
   */
  private replaceContent(content: string) {
    const root = $getRoot();
    root.clear();
    
    const lines = content.split('\n');
    lines.forEach((line, index) => {
      const paragraph = $createParagraphNode();
      if (line.length > 0) {
        const textNode = $createTextNode(line);
        paragraph.append(textNode);
      }
      root.append(paragraph);
    });
  }

  /**
   * Append content to the end of the document
   */
  private appendContent(content: string) {
    const root = $getRoot();
    const lines = content.split('\n');
    
    lines.forEach((line) => {
      const paragraph = $createParagraphNode();
      if (line.length > 0) {
        const textNode = $createTextNode(line);
        paragraph.append(textNode);
      }
      root.append(paragraph);
    });
  }

  /**
   * Insert content at cursor position
   */
  private insertAtCursor(content: string) {
    const selection = $getSelection();
    if ($isRangeSelection(selection)) {
      selection.insertText(content);
    } else {
      // If no selection, append to document
      this.appendContent(content);
    }
  }

  /**
   * Insert content at specific position
   */
  private insertAtPosition(content: string, position: { line: number; column: number }) {
    // This would require more complex logic to navigate to the specific line/column
    // For now, we'll insert at cursor
    this.insertAtCursor(content);
  }

  /**
   * Delete a range of text
   */
  private deleteRange(range: { start: { line: number; column: number }; end: { line: number; column: number } }) {
    // This would require complex range selection logic
    // For now, we'll clear selection if any
    const selection = $getSelection();
    if ($isRangeSelection(selection)) {
      selection.removeText();
    }
  }

  /**
   * Edit (replace) a specific range with new content
   */
  private editRange(range: { start: { line: number; column: number }; end: { line: number; column: number } }, content: string) {
    // This would require complex range selection and replacement
    // For now, we'll replace selection if any
    const selection = $getSelection();
    if ($isRangeSelection(selection)) {
      selection.insertText(content);
    }
  }

  /**
   * Get the current document content as plain text
   */
  getContent(): string {
    let content = '';
    this.editor.getEditorState().read(() => {
      const root = $getRoot();
      content = root.getTextContent();
    });
    return content;
  }

  /**
   * Get current selection as text
   */
  getSelectedText(): string | null {
    let selectedText: string | null = null;
    this.editor.getEditorState().read(() => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) {
        selectedText = selection.getTextContent();
      }
    });
    return selectedText;
  }

  /**
   * Clear edit history
   */
  clearHistory() {
    this.editor.dispatchCommand(CLEAR_HISTORY_COMMAND, undefined);
  }
}