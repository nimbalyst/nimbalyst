import { describe, it, expect, beforeEach } from 'vitest';
import { DocumentContextService } from '../DocumentContextService';
import type { RawDocumentContext } from '../types';

describe('DocumentContextService', () => {
  let service: DocumentContextService;

  beforeEach(() => {
    service = new DocumentContextService();
  });

  describe('prepareContext', () => {
    describe('document transitions', () => {
      it('detects "opened" transition when first viewing a file', () => {
        const rawContext: RawDocumentContext = {
          filePath: '/test/file.ts',
          fileType: 'typescript',
          content: 'const x = 1;',
        };

        const result = service.prepareContext(rawContext, 'session-1', 'claude', undefined);

        expect(result.documentContext.documentTransition).toBe('opened');
        expect(result.documentContext.filePath).toBe('/test/file.ts');
        expect(result.documentContext.content).toBe('const x = 1;');
        expect(result.documentContext.documentDiff).toBeUndefined();
      });

      it('detects "none" transition when content is unchanged and omits content', () => {
        const rawContext: RawDocumentContext = {
          filePath: '/test/file.ts',
          fileType: 'typescript',
          content: 'const x = 1;',
        };

        // First message - opened
        service.prepareContext(rawContext, 'session-1', 'claude', undefined);

        // Second message - same content
        const result = service.prepareContext(rawContext, 'session-1', 'claude', undefined);

        expect(result.documentContext.documentTransition).toBe('none');
        // Content should be omitted when nothing changed - AI already has the context
        expect(result.documentContext.content).toBeUndefined();
        expect(result.documentContext.documentDiff).toBeUndefined();
        // But filePath should still be present so AI knows which file we're looking at
        expect(result.documentContext.filePath).toBe('/test/file.ts');
      });

      it('detects "modified" transition when content changes', () => {
        const rawContext1: RawDocumentContext = {
          filePath: '/test/file.ts',
          fileType: 'typescript',
          content: 'const x = 1;',
        };

        const rawContext2: RawDocumentContext = {
          filePath: '/test/file.ts',
          fileType: 'typescript',
          content: 'const x = 2;',
        };

        // First message - opened
        service.prepareContext(rawContext1, 'session-1', 'claude', undefined);

        // Second message - modified
        const result = service.prepareContext(rawContext2, 'session-1', 'claude', undefined);

        expect(result.documentContext.documentTransition).toBe('modified');
      });

      it('detects "switched" transition when changing files', () => {
        const rawContext1: RawDocumentContext = {
          filePath: '/test/file1.ts',
          fileType: 'typescript',
          content: 'const x = 1;',
        };

        const rawContext2: RawDocumentContext = {
          filePath: '/test/file2.ts',
          fileType: 'typescript',
          content: 'const y = 2;',
        };

        // First message - opened file1
        service.prepareContext(rawContext1, 'session-1', 'claude', undefined);

        // Second message - switched to file2
        const result = service.prepareContext(rawContext2, 'session-1', 'claude', undefined);

        expect(result.documentContext.documentTransition).toBe('switched');
        expect(result.documentContext.previousFilePath).toBe('/test/file1.ts');
        expect(result.documentContext.filePath).toBe('/test/file2.ts');
      });

      it('detects "closed" transition when no longer viewing any file', () => {
        const rawContext: RawDocumentContext = {
          filePath: '/test/file.ts',
          fileType: 'typescript',
          content: 'const x = 1;',
        };

        // First message - opened
        service.prepareContext(rawContext, 'session-1', 'claude', undefined);

        // Second message - no file
        const result = service.prepareContext(undefined, 'session-1', 'claude', undefined);

        expect(result.documentContext.documentTransition).toBe('closed');
        expect(result.documentContext.previousFilePath).toBe('/test/file.ts');
      });
    });

    describe('content vs diff decision', () => {
      it('sends full content for non-claude-code providers', () => {
        const rawContext1: RawDocumentContext = {
          filePath: '/test/file.ts',
          fileType: 'typescript',
          content: 'const x = 1;',
        };

        const rawContext2: RawDocumentContext = {
          filePath: '/test/file.ts',
          fileType: 'typescript',
          content: 'const x = 2;',
        };

        service.prepareContext(rawContext1, 'session-1', 'claude', undefined);
        const result = service.prepareContext(rawContext2, 'session-1', 'claude', undefined);

        expect(result.documentContext.content).toBe('const x = 2;');
        expect(result.documentContext.documentDiff).toBeUndefined();
      });

      it('sends diff instead of content for claude-code on modified transition', () => {
        // Use a larger file so the diff is smaller than the full content
        const largeContent1 = `// This is a test file with lots of content
function test1() {
  console.log('test1');
}

function test2() {
  console.log('test2');
}

function test3() {
  console.log('test3');
}

function test4() {
  console.log('test4');
}

const x = 1;

function test5() {
  console.log('test5');
}

function test6() {
  console.log('test6');
}
`;

        const largeContent2 = `// This is a test file with lots of content
function test1() {
  console.log('test1');
}

function test2() {
  console.log('test2');
}

function test3() {
  console.log('test3');
}

function test4() {
  console.log('test4');
}

const x = 2;

function test5() {
  console.log('test5');
}

function test6() {
  console.log('test6');
}
`;

        const rawContext1: RawDocumentContext = {
          filePath: '/test/file.ts',
          fileType: 'typescript',
          content: largeContent1,
        };

        const rawContext2: RawDocumentContext = {
          filePath: '/test/file.ts',
          fileType: 'typescript',
          content: largeContent2,
        };

        service.prepareContext(rawContext1, 'session-1', 'claude-code', undefined);
        const result = service.prepareContext(rawContext2, 'session-1', 'claude-code', undefined);

        expect(result.documentContext.documentTransition).toBe('modified');
        expect(result.documentContext.content).toBeUndefined();
        expect(result.documentContext.documentDiff).toBeDefined();
        expect(result.documentContext.documentDiff).toContain('-const x = 1;');
        expect(result.documentContext.documentDiff).toContain('+const x = 2;');
      });

      it('sends full content for claude-code on opened transition', () => {
        const rawContext: RawDocumentContext = {
          filePath: '/test/file.ts',
          fileType: 'typescript',
          content: 'const x = 1;',
        };

        const result = service.prepareContext(rawContext, 'session-1', 'claude-code', undefined);

        expect(result.documentContext.documentTransition).toBe('opened');
        expect(result.documentContext.content).toBe('const x = 1;');
        expect(result.documentContext.documentDiff).toBeUndefined();
      });

      it('truncates content to 2000 characters for claude-code', () => {
        // Create content longer than 2000 characters
        const longContent = 'x'.repeat(3000);

        const rawContext: RawDocumentContext = {
          filePath: '/test/file.ts',
          fileType: 'typescript',
          content: longContent,
        };

        const result = service.prepareContext(rawContext, 'session-1', 'claude-code', undefined);

        expect(result.documentContext.content).toHaveLength(2000);
        expect(result.documentContext.contentTruncated).toBe(true);
      });

      it('does not truncate content for chat providers', () => {
        // Create content longer than 2000 characters
        const longContent = 'x'.repeat(3000);

        const rawContext: RawDocumentContext = {
          filePath: '/test/file.ts',
          fileType: 'typescript',
          content: longContent,
        };

        const result = service.prepareContext(rawContext, 'session-1', 'claude', undefined);

        expect(result.documentContext.content).toHaveLength(3000);
        expect(result.documentContext.contentTruncated).toBeUndefined();
      });

      it('does not truncate content under 2000 characters for claude-code', () => {
        const shortContent = 'const x = 1;';

        const rawContext: RawDocumentContext = {
          filePath: '/test/file.ts',
          fileType: 'typescript',
          content: shortContent,
        };

        const result = service.prepareContext(rawContext, 'session-1', 'claude-code', undefined);

        expect(result.documentContext.content).toBe(shortContent);
        expect(result.documentContext.contentTruncated).toBeUndefined();
      });

      it('includes truncation notice in document context prompt for chat providers', () => {
        const longContent = 'x'.repeat(3000);

        const rawContext: RawDocumentContext = {
          filePath: '/test/file.ts',
          fileType: 'typescript',
          content: longContent,
        };

        // Use a chat provider (like 'claude') which includes content in the prompt
        const result = service.prepareContext(rawContext, 'session-1', 'claude', undefined, { truncateContent: true });

        expect(result.userMessageAdditions.documentContextPrompt).toContain('Content truncated to first 2000 characters');
        expect(result.userMessageAdditions.documentContextPrompt).toContain('Use the Read tool to see the full file');
      });

      it('excludes content entirely for claude-code (no truncation notice needed)', () => {
        const longContent = 'x'.repeat(3000);

        const rawContext: RawDocumentContext = {
          filePath: '/test/file.ts',
          fileType: 'typescript',
          content: longContent,
        };

        const result = service.prepareContext(rawContext, 'session-1', 'claude-code', undefined);

        // claude-code should not get DOCUMENT_CONTENT at all
        expect(result.userMessageAdditions.documentContextPrompt).not.toContain('<DOCUMENT_CONTENT>');
        expect(result.userMessageAdditions.documentContextPrompt).not.toContain('Content truncated');
      });
    });

    describe('text selection normalization', () => {
      it('extracts text from textSelection string format (new simplified format)', () => {
        const rawContext: RawDocumentContext = {
          filePath: '/test/file.ts',
          fileType: 'typescript',
          content: 'const x = 1;',
          textSelection: 'const x',  // Simplified: just the text
          textSelectionTimestamp: 123456,  // Timestamp is separate
        };

        const result = service.prepareContext(rawContext, 'session-1', 'claude', undefined);

        expect(result.documentContext.textSelection).toBe('const x');
      });

      it('extracts text from textSelection object format (legacy format)', () => {
        const rawContext: RawDocumentContext = {
          filePath: '/test/file.ts',
          fileType: 'typescript',
          content: 'const x = 1;',
          textSelection: {
            text: 'const x',
            filePath: '/test/file.ts',
            timestamp: 123456,
          },
        };

        const result = service.prepareContext(rawContext, 'session-1', 'claude', undefined);

        // textSelection is now just the text string
        expect(result.documentContext.textSelection).toBe('const x');
      });

      it('extracts text from selection as object with text property', () => {
        const rawContext: RawDocumentContext = {
          filePath: '/test/file.ts',
          fileType: 'typescript',
          content: 'const x = 1;',
          selection: {
            text: 'const x',
            filePath: '/test/file.ts',
            timestamp: 123456,
          },
        };

        const result = service.prepareContext(rawContext, 'session-1', 'claude', undefined);

        expect(result.documentContext.textSelection).toBe('const x');
      });

      it('extracts text from selection as string (legacy format)', () => {
        const rawContext: RawDocumentContext = {
          filePath: '/test/file.ts',
          fileType: 'typescript',
          content: 'const x = 1;',
          selection: 'const x',
          textSelectionTimestamp: 123456,
        };

        const result = service.prepareContext(rawContext, 'session-1', 'claude', undefined);

        expect(result.documentContext.textSelection).toBe('const x');
      });

      it('returns undefined when no selection present', () => {
        const rawContext: RawDocumentContext = {
          filePath: '/test/file.ts',
          fileType: 'typescript',
          content: 'const x = 1;',
        };

        const result = service.prepareContext(rawContext, 'session-1', 'claude', undefined);

        expect(result.documentContext.textSelection).toBeUndefined();
      });
    });

    describe('user message additions', () => {
      it('does not inject plan mode instructions (SDK handles natively)', () => {
        const rawContext: RawDocumentContext = {
          filePath: '/test/file.ts',
          fileType: 'typescript',
          content: 'const x = 1;',
        };

        const result = service.prepareContext(rawContext, 'session-1', 'claude', {
          enteringPlanMode: true,
          planFilePath: '/plans/test-plan.md',
        });

        // Plan mode instructions are no longer injected - SDK handles via permissionMode: 'plan'
        expect((result.userMessageAdditions as any).planModeInstructions).toBeUndefined();
        expect((result.userMessageAdditions as any).planModeDeactivation).toBeUndefined();
      });

      it('builds document context prompt with file path and content', () => {
        const rawContext: RawDocumentContext = {
          filePath: '/test/file.ts',
          fileType: 'typescript',
          content: 'const x = 1;',
        };

        const result = service.prepareContext(rawContext, 'session-1', 'claude', undefined);

        expect(result.userMessageAdditions.documentContextPrompt).toBeDefined();
        expect(result.userMessageAdditions.documentContextPrompt).toContain('<ACTIVE_DOCUMENT>/test/file.ts</ACTIVE_DOCUMENT>');
        expect(result.userMessageAdditions.documentContextPrompt).toContain('<DOCUMENT_CONTENT>');
        expect(result.userMessageAdditions.documentContextPrompt).toContain('const x = 1;');
        expect(result.userMessageAdditions.documentContextPrompt).toContain('</DOCUMENT_CONTENT>');
      });

      it('excludes DOCUMENT_CONTENT for claude-code sessions', () => {
        const rawContext: RawDocumentContext = {
          filePath: '/test/file.ts',
          fileType: 'typescript',
          content: 'const x = 1;',
        };

        const result = service.prepareContext(rawContext, 'session-1', 'claude-code', undefined);

        expect(result.userMessageAdditions.documentContextPrompt).toBeDefined();
        expect(result.userMessageAdditions.documentContextPrompt).toContain('<ACTIVE_DOCUMENT>/test/file.ts</ACTIVE_DOCUMENT>');
        // Should NOT include DOCUMENT_CONTENT for claude-code (it has file system access)
        expect(result.userMessageAdditions.documentContextPrompt).not.toContain('<DOCUMENT_CONTENT>');
        expect(result.userMessageAdditions.documentContextPrompt).not.toContain('const x = 1;');
      });

      it('includes cursor position in document context prompt when provided', () => {
        const rawContext: RawDocumentContext = {
          filePath: '/test/file.ts',
          fileType: 'typescript',
          content: 'const x = 1;',
          cursorPosition: { line: 5, column: 10 },
        };

        const result = service.prepareContext(rawContext, 'session-1', 'claude', undefined);

        expect(result.userMessageAdditions.documentContextPrompt).toContain('Cursor: Line 5, Column 10');
      });

      it('includes selected text in document context prompt', () => {
        const rawContext: RawDocumentContext = {
          filePath: '/test/file.ts',
          fileType: 'typescript',
          content: 'const x = 1;',
          textSelection: 'const x',
        };

        const result = service.prepareContext(rawContext, 'session-1', 'claude', undefined);

        expect(result.userMessageAdditions.documentContextPrompt).toContain('<SELECTED_TEXT>');
        expect(result.userMessageAdditions.documentContextPrompt).toContain('const x');
        expect(result.userMessageAdditions.documentContextPrompt).toContain('</SELECTED_TEXT>');
      });

      it('includes staleness warning for old selections', () => {
        const rawContext: RawDocumentContext = {
          filePath: '/test/file.ts',
          fileType: 'typescript',
          content: 'const x = 1;',
          textSelection: 'const x',
          textSelectionTimestamp: Date.now() - 120000, // 2 minutes ago
        };

        const result = service.prepareContext(rawContext, 'session-1', 'claude', undefined);

        expect(result.userMessageAdditions.documentContextPrompt).toContain('selection was made over a minute ago');
      });

      it('shows diff for modified documents instead of full content', () => {
        // Use a much larger file so diff is smaller than content
        // The diff algorithm only returns diff if it's smaller than full content
        const lines = Array.from({ length: 30 }, (_, i) => `function test${i}() { console.log('test${i}'); }`);
        const middleIndex = 15;

        const largeContent1 = [
          ...lines.slice(0, middleIndex),
          'const x = 1;',
          ...lines.slice(middleIndex),
        ].join('\n');

        const largeContent2 = [
          ...lines.slice(0, middleIndex),
          'const x = 2;',
          ...lines.slice(middleIndex),
        ].join('\n');

        const rawContext1: RawDocumentContext = {
          filePath: '/test/file.ts',
          content: largeContent1,
        };

        const rawContext2: RawDocumentContext = {
          filePath: '/test/file.ts',
          content: largeContent2,
        };

        service.prepareContext(rawContext1, 'session-1', 'claude-code', undefined);
        const result = service.prepareContext(rawContext2, 'session-1', 'claude-code', undefined);

        expect(result.userMessageAdditions.documentContextPrompt).toContain('<DOCUMENT_DIFF>');
        expect(result.userMessageAdditions.documentContextPrompt).toContain('-const x = 1;');
        expect(result.userMessageAdditions.documentContextPrompt).toContain('+const x = 2;');
        expect(result.userMessageAdditions.documentContextPrompt).toContain('</DOCUMENT_DIFF>');
      });

      it('shows unchanged message for none transition', () => {
        const rawContext: RawDocumentContext = {
          filePath: '/test/file.ts',
          content: 'const x = 1;',
        };

        service.prepareContext(rawContext, 'session-1', 'claude', undefined);
        const result = service.prepareContext(rawContext, 'session-1', 'claude', undefined);

        expect(result.userMessageAdditions.documentContextPrompt).toContain('Document content unchanged');
      });

      it('shows closed transition message', () => {
        const rawContext: RawDocumentContext = {
          filePath: '/test/file.ts',
          content: 'const x = 1;',
        };

        service.prepareContext(rawContext, 'session-1', 'claude', undefined);
        const result = service.prepareContext(undefined, 'session-1', 'claude', undefined);

        expect(result.userMessageAdditions.documentContextPrompt).toContain('closed the document');
        expect(result.userMessageAdditions.documentContextPrompt).toContain('/test/file.ts');
      });

      it('shows switched transition message', () => {
        const rawContext1: RawDocumentContext = {
          filePath: '/test/file1.ts',
          content: 'const x = 1;',
        };

        const rawContext2: RawDocumentContext = {
          filePath: '/test/file2.ts',
          content: 'const y = 2;',
        };

        service.prepareContext(rawContext1, 'session-1', 'claude', undefined);
        const result = service.prepareContext(rawContext2, 'session-1', 'claude', undefined);

        expect(result.userMessageAdditions.documentContextPrompt).toContain('switched from');
        expect(result.userMessageAdditions.documentContextPrompt).toContain('/test/file1.ts');
        expect(result.userMessageAdditions.documentContextPrompt).toContain('/test/file2.ts');
      });

      it('includes mockup selection in document context prompt', () => {
        const rawContext: RawDocumentContext = {
          filePath: '/test/mockup.html',
          fileType: 'mockup',
          content: '<button>Click me</button>',
          mockupSelection: {
            tagName: 'button',
            selector: '#my-button',
            outerHTML: '<button id="my-button">Click me</button>',
          },
        };

        const result = service.prepareContext(rawContext, 'session-1', 'claude', undefined);

        expect(result.userMessageAdditions.documentContextPrompt).toContain('<SELECTED_MOCKUP_ELEMENT>');
        expect(result.userMessageAdditions.documentContextPrompt).toContain('Tag: <button>');
        expect(result.userMessageAdditions.documentContextPrompt).toContain('#my-button');
        expect(result.userMessageAdditions.documentContextPrompt).toContain('</SELECTED_MOCKUP_ELEMENT>');
      });

      it('includes mockup drawing note in document context prompt', () => {
        const rawContext: RawDocumentContext = {
          filePath: '/test/mockup.html',
          fileType: 'mockup',
          content: '<div>Content</div>',
          mockupDrawing: 'data:image/png;base64,iVBORw0KGgoAAAANS...',  // Data URL indicates annotation exists
        };

        const result = service.prepareContext(rawContext, 'session-1', 'claude', undefined);

        expect(result.userMessageAdditions.documentContextPrompt).toContain('drawn annotations');
        expect(result.userMessageAdditions.documentContextPrompt).toContain('capture_editor_screenshot');
      });
    });

    describe('one-time editing instructions', () => {
      it('adds editing instructions on first message with document', () => {
        const rawContext: RawDocumentContext = {
          filePath: '/test/file.ts',
          content: 'const x = 1;',
        };

        const result = service.prepareContext(rawContext, 'session-1', 'claude', undefined);

        expect(result.userMessageAdditions.editingInstructions).toBeDefined();
        expect(result.userMessageAdditions.editingInstructions).toContain('<OPEN_FILE_INSTRUCTIONS>');
        expect(result.userMessageAdditions.editingInstructions).toContain('Read tool');
        expect(result.userMessageAdditions.editingInstructions).toContain('Edit tool');
        expect(result.userMessageAdditions.editingInstructions).toContain('</OPEN_FILE_INSTRUCTIONS>');
      });

      it('does not add editing instructions on subsequent messages', () => {
        const rawContext: RawDocumentContext = {
          filePath: '/test/file.ts',
          content: 'const x = 1;',
        };

        // First message
        const result1 = service.prepareContext(rawContext, 'session-1', 'claude', undefined);
        expect(result1.userMessageAdditions.editingInstructions).toBeDefined();

        // Second message
        const result2 = service.prepareContext(rawContext, 'session-1', 'claude', undefined);
        expect(result2.userMessageAdditions.editingInstructions).toBeUndefined();
      });

      it('does not add editing instructions when no document is open', () => {
        const result = service.prepareContext(undefined, 'session-1', 'claude', undefined);

        expect(result.userMessageAdditions.editingInstructions).toBeUndefined();
      });

      it('tracks editing instructions per session independently', () => {
        const rawContext: RawDocumentContext = {
          filePath: '/test/file.ts',
          content: 'const x = 1;',
        };

        // Session 1 - first message
        const result1 = service.prepareContext(rawContext, 'session-1', 'claude', undefined);
        expect(result1.userMessageAdditions.editingInstructions).toBeDefined();

        // Session 2 - first message (should also get instructions)
        const result2 = service.prepareContext(rawContext, 'session-2', 'claude', undefined);
        expect(result2.userMessageAdditions.editingInstructions).toBeDefined();

        // Session 1 - second message (no instructions)
        const result3 = service.prepareContext(rawContext, 'session-1', 'claude', undefined);
        expect(result3.userMessageAdditions.editingInstructions).toBeUndefined();
      });
    });
  });

  describe('session state management', () => {
    it('tracks state per session independently', () => {
      const rawContext1: RawDocumentContext = {
        filePath: '/test/file1.ts',
        fileType: 'typescript',
        content: 'const x = 1;',
      };

      const rawContext2: RawDocumentContext = {
        filePath: '/test/file2.ts',
        fileType: 'typescript',
        content: 'const y = 2;',
      };

      // Session 1
      const result1a = service.prepareContext(rawContext1, 'session-1', 'claude', undefined);
      expect(result1a.documentContext.documentTransition).toBe('opened');

      // Session 2
      const result2a = service.prepareContext(rawContext2, 'session-2', 'claude', undefined);
      expect(result2a.documentContext.documentTransition).toBe('opened');

      // Session 1 again - should remember state
      const result1b = service.prepareContext(rawContext1, 'session-1', 'claude', undefined);
      expect(result1b.documentContext.documentTransition).toBe('none');
    });

    it('clears session state', () => {
      const rawContext: RawDocumentContext = {
        filePath: '/test/file.ts',
        fileType: 'typescript',
        content: 'const x = 1;',
      };

      service.prepareContext(rawContext, 'session-1', 'claude', undefined);
      expect(service.getSessionState('session-1')).toBeDefined();

      service.clearSessionState('session-1');
      expect(service.getSessionState('session-1')).toBeUndefined();

      // Next message should be "opened" again
      const result = service.prepareContext(rawContext, 'session-1', 'claude', undefined);
      expect(result.documentContext.documentTransition).toBe('opened');
    });

    it('automatically clears state on closed transition', () => {
      const rawContext: RawDocumentContext = {
        filePath: '/test/file.ts',
        fileType: 'typescript',
        content: 'const x = 1;',
      };

      service.prepareContext(rawContext, 'session-1', 'claude', undefined);
      expect(service.getSessionState('session-1')).toBeDefined();

      service.prepareContext(undefined, 'session-1', 'claude', undefined);
      expect(service.getSessionState('session-1')).toBeUndefined();
    });

    it('returns cached session state for debugging', () => {
      const rawContext: RawDocumentContext = {
        filePath: '/test/file.ts',
        fileType: 'typescript',
        content: 'const x = 1;',
      };

      service.prepareContext(rawContext, 'session-1', 'claude', undefined);

      const state = service.getSessionState('session-1');
      expect(state).toBeDefined();
      expect(state?.filePath).toBe('/test/file.ts');
      expect(state?.content).toBe('const x = 1;');
      expect(state?.contentHash).toBeDefined();
    });
  });

  describe('persistence', () => {
    it('calls persist callback when state changes', async () => {
      const persistedStates: Array<{ sessionId: string; state: any }> = [];
      service.setPersistCallback(async (sessionId, state) => {
        persistedStates.push({ sessionId, state });
      });

      const rawContext: RawDocumentContext = {
        filePath: '/test/file.ts',
        fileType: 'typescript',
        content: 'const x = 1;',
      };

      service.prepareContext(rawContext, 'session-1', 'claude', undefined);

      // Wait for async callback
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(persistedStates).toHaveLength(1);
      expect(persistedStates[0].sessionId).toBe('session-1');
      expect(persistedStates[0].state).toEqual({
        filePath: '/test/file.ts',
        contentHash: expect.any(String),
      });
    });

    it('calls persist callback with null when document is closed', async () => {
      const persistedStates: Array<{ sessionId: string; state: any }> = [];
      service.setPersistCallback(async (sessionId, state) => {
        persistedStates.push({ sessionId, state });
      });

      const rawContext: RawDocumentContext = {
        filePath: '/test/file.ts',
        fileType: 'typescript',
        content: 'const x = 1;',
      };

      service.prepareContext(rawContext, 'session-1', 'claude', undefined);
      service.prepareContext(undefined, 'session-1', 'claude', undefined);

      // Wait for async callbacks
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(persistedStates).toHaveLength(2);
      expect(persistedStates[1].state).toBeNull();
    });

    it('loads persisted state and detects unchanged file', () => {
      // Simulate app restart by loading persisted state
      service.loadPersistedState('session-1', {
        filePath: '/test/file.ts',
        contentHash: '7c9e6679', // Hash for 'const x = 1;'
      });

      // User opens same file with same content - need to compute actual hash
      const rawContext: RawDocumentContext = {
        filePath: '/test/file.ts',
        fileType: 'typescript',
        content: 'const x = 1;',
      };

      // We need the actual hash - let's first compute it
      service.clearSessionState('session-1');
      const firstResult = service.prepareContext(rawContext, 'session-1', 'claude', undefined);
      const actualHash = service.getSessionState('session-1')?.contentHash;

      // Now test with correct hash
      service.clearSessionState('session-1');
      service.loadPersistedState('session-1', {
        filePath: '/test/file.ts',
        contentHash: actualHash!,
      });

      const result = service.prepareContext(rawContext, 'session-1', 'claude', undefined);

      // Should detect content is unchanged since hash matches
      expect(result.documentContext.documentTransition).toBe('none');
    });

    it('loads persisted state and detects modified file (no diff available)', () => {
      // First, compute the hash for the original content
      const originalContext: RawDocumentContext = {
        filePath: '/test/file.ts',
        fileType: 'typescript',
        content: 'const x = 1;',
      };
      service.prepareContext(originalContext, 'temp-session', 'claude', undefined);
      const originalHash = service.getSessionState('temp-session')?.contentHash;

      // Simulate app restart with persisted hash (but no content)
      service.loadPersistedState('session-1', {
        filePath: '/test/file.ts',
        contentHash: originalHash!,
      });

      // User opens file but content has changed
      const modifiedContext: RawDocumentContext = {
        filePath: '/test/file.ts',
        fileType: 'typescript',
        content: 'const x = 999;',
      };

      const result = service.prepareContext(modifiedContext, 'session-1', 'claude', undefined);

      // Should detect modification but cannot provide diff (no previous content)
      expect(result.documentContext.documentTransition).toBe('modified');
      // Full content should be sent since we can't compute diff without previous content
      expect(result.documentContext.content).toBe('const x = 999;');
      expect(result.documentContext.documentDiff).toBeUndefined();
    });
  });

  describe('editor context items (multi-selection)', () => {
    it('emits a SELECTED_ITEMS block with each item label and description', () => {
      const rawContext: RawDocumentContext = {
        filePath: '/test/diagram.excalidraw',
        fileType: 'excalidraw',
        content: '{}',
        editorContextItems: [
          { id: 'a1', label: 'Rectangle 3', description: 'A rectangle at (10, 20).' },
          { id: 'b2', label: 'Arrow 7', description: 'An arrow from Rectangle 3 to Ellipse 1.' },
        ],
      };

      const result = service.prepareContext(rawContext, 'session-items', 'claude', undefined);
      const prompt = result.userMessageAdditions.documentContextPrompt ?? '';

      expect(prompt).toContain('<SELECTED_ITEMS>');
      expect(prompt).toContain('selected the following 2 items');
      expect(prompt).toContain('<ITEM label="Rectangle 3">');
      expect(prompt).toContain('A rectangle at (10, 20).');
      expect(prompt).toContain('<ITEM label="Arrow 7">');
      expect(prompt).toContain('An arrow from Rectangle 3 to Ellipse 1.');
    });

    it('inlines structured data only when includeData is set', () => {
      const rawContext: RawDocumentContext = {
        filePath: '/test/board.circuit.tsx',
        fileType: 'code',
        content: '{}',
        editorContextItems: [
          { id: 'r12', label: 'R12', description: 'A resistor.', data: { value: '10k' }, includeData: true },
          { id: 'c3', label: 'C3', description: 'A capacitor.', data: { value: '100n' } },
        ],
      };

      const result = service.prepareContext(rawContext, 'session-data', 'claude', undefined);
      const prompt = result.userMessageAdditions.documentContextPrompt ?? '';

      // R12 opted in -> data present; C3 did not -> data omitted
      expect(prompt).toContain('<DATA>{&quot;value&quot;:&quot;10k&quot;}</DATA>');
      expect(prompt).not.toContain('100n');
    });

    it('escapes item markup and omits data that cannot be serialized safely', () => {
      const rawContext: RawDocumentContext = {
        filePath: '/test/diagram.excalidraw',
        fileType: 'excalidraw',
        content: '{}',
        editorContextItems: [
          {
            id: 'unsafe',
            label: 'Text "quoted" <node>',
            description: 'Contains </ITEM> & more',
            data: { count: 1n },
            includeData: true,
          },
        ],
      };

      const result = service.prepareContext(rawContext, 'session-unsafe', 'claude', undefined);
      const prompt = result.userMessageAdditions.documentContextPrompt ?? '';

      expect(prompt).toContain('label="Text &quot;quoted&quot; &lt;node&gt;"');
      expect(prompt).toContain('Contains &lt;/ITEM&gt; &amp; more');
      expect(prompt).not.toContain('<DATA>');
    });

    it('produces no SELECTED_ITEMS block when there are no items', () => {
      const rawContext: RawDocumentContext = {
        filePath: '/test/file.ts',
        fileType: 'typescript',
        content: 'const x = 1;',
      };

      const result = service.prepareContext(rawContext, 'session-empty', 'claude', undefined);
      const prompt = result.userMessageAdditions.documentContextPrompt ?? '';

      expect(prompt).not.toContain('<SELECTED_ITEMS>');
    });
  });
});
