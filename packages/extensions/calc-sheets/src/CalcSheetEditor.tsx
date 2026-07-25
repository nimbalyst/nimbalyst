import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { IDisposable } from 'monaco-editor';
import type { EditorHostProps } from '@nimbalyst/extension-sdk';
import { MonacoEditor, type MonacoEditorCollabConfig } from '@nimbalyst/runtime';
import { applyCalcSheetMonaco } from './calcSheetMonaco';
import { evaluateCalcSheet } from './evaluator';
import { parseCalcSheetDocument } from './parser';
import {
  buildCalcSheetSelectionContextItems,
  type CalcSheetSelectionRange,
} from './selectionContext';

function lineTitle(
  line: ReturnType<typeof parseCalcSheetDocument>['lines'][number],
  evaluation: ReturnType<typeof evaluateCalcSheet>,
): string | undefined {
  if (line.kind === 'binding' && line.binding) {
    const result = evaluation.bindings.get(line.binding.name);
    if (!result) return undefined;
    const parts = [
      `${result.classification === 'constant' ? 'Constant' : 'Formula'}: ${line.binding.name}`,
    ];
    if (result.dependencies.length > 0) {
      parts.push(`Depends on: ${result.dependencies.join(', ')}`);
    }
    if (result.error) {
      parts.push(`Error: ${result.error}`);
    }
    return parts.join('\n');
  }
  if (line.kind === 'assert' && line.assertion) {
    const assertion = evaluation.assertions.find(
      (entry) => entry.expression === line.assertion?.expression,
    );
    if (!assertion) return undefined;
    const parts = [`Assertion: ${line.assertion.expression}`];
    if (assertion.dependencies.length > 0) {
      parts.push(`Depends on: ${assertion.dependencies.join(', ')}`);
    }
    if (assertion.error) {
      parts.push(`Error: ${assertion.error}`);
    }
    return parts.join('\n');
  }
  if (line.parseError) {
    return line.parseError;
  }
  return undefined;
}

export function CalcSheetEditor({ host }: EditorHostProps) {
  const [rawContent, setRawContent] = useState<string | null>(null);
  const [readOnly, setReadOnly] = useState<boolean>(host.readOnly ?? false);
  const gutterRef = useRef<HTMLDivElement | null>(null);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const editorRef = useRef<any>(null);
  const contentListenerRef = useRef<IDisposable | null>(null);
  const scrollListenerRef = useRef<IDisposable | null>(null);
  const contentSizeListenerRef = useRef<IDisposable | null>(null);
  const layoutListenerRef = useRef<IDisposable | null>(null);
  const selectionListenerRef = useRef<IDisposable | null>(null);
  const frontmatterBlockRef = useRef('');
  const [lineTops, setLineTops] = useState<number[]>([]);
  const [contentHeight, setContentHeight] = useState(0);
  const [editorSelection, setEditorSelection] = useState<CalcSheetSelectionRange | null>(null);
  const editorLineHeight = 30;

  // Collaborative when the host stood up a sync channel. In that mode the whole
  // file (frontmatter + body) lives in a single shared Y.Text bound to the
  // Monaco model; we visually hide the frontmatter lines so the body-only UX is
  // preserved while the frontmatter still syncs.
  const collaborative = !!host.collaboration;

  // Hide the leading frontmatter block in the editor pane (it stays in the
  // model so it syncs). `bodyStartLine` is the count of frontmatter lines.
  const applyFrontmatterHide = useCallback(
    (editor: any, monaco: any) => {
      if (!editor || !monaco || typeof editor.setHiddenAreas !== 'function') return;
      const offset = parseCalcSheetDocument(editor.getValue()).bodyStartLine;
      editor.setHiddenAreas(offset > 0 ? [new monaco.Range(1, 1, offset, 1)] : []);
    },
    [],
  );

  const collabConfig = useMemo<MonacoEditorCollabConfig | undefined>(
    () =>
      collaborative
        ? {
            textField: 'content',
            onBindingReady: ({ editor, monaco }) => {
              applyFrontmatterHide(editor, monaco);
            },
          }
        : undefined,
    [collaborative, applyFrontmatterHide],
  );

  useEffect(() => {
    setReadOnly(host.readOnly ?? false);
    return host.onReadOnlyChanged?.((next) => {
      setReadOnly(next);
    });
  }, [host]);

  useEffect(() => {
    let mounted = true;
    host.loadContent()
      .then((nextContent) => {
        if (!mounted) return;
        setRawContent(nextContent);
      })
      .catch((error) => {
        if (!mounted) return;
        setLoadError(error instanceof Error ? error : new Error('Failed to load content'));
      });
    return () => {
      mounted = false;
    };
  }, [host]);

  useEffect(() => {
    return () => {
      contentListenerRef.current?.dispose();
      scrollListenerRef.current?.dispose();
      contentSizeListenerRef.current?.dispose();
      layoutListenerRef.current?.dispose();
      selectionListenerRef.current?.dispose();
    };
  }, []);

  const parsed = useMemo(() => parseCalcSheetDocument(rawContent ?? ''), [rawContent]);
  frontmatterBlockRef.current = parsed.frontmatterBlock;

  // The result gutter overlays the editor and is positioned by model line.
  // Locally the model is body-only (offset 0); in collab mode the model holds
  // the whole file, so body line N sits at model line bodyStartLine + N.
  const gutterLineOffset = collaborative ? parsed.bodyStartLine : 0;

  const evaluation = useMemo(
    () => evaluateCalcSheet(parsed.lines, parsed.frontmatter, parsed.lines.length),
    [parsed],
  );

  const editorContextItems = useMemo(
    () => buildCalcSheetSelectionContextItems({
      parsed,
      evaluation,
      selection: editorSelection,
      modelLineOffset: collaborative ? parsed.bodyStartLine : 0,
    }),
    [collaborative, editorSelection, evaluation, parsed],
  );

  useEffect(() => {
    host.setEditorContextItems(editorContextItems.length > 0 ? editorContextItems : null);
  }, [editorContextItems, host]);

  useEffect(() => () => host.setEditorContextItems(null), [host]);

  const refreshLayout = useCallback((editor: any) => {
    const model = editor?.getModel?.();
    if (!model) {
      setLineTops([]);
      setContentHeight(0);
      return;
    }

    const nextLineTops: number[] = [];
    const lineCount = model.getLineCount();
    for (let lineNumber = 1; lineNumber <= lineCount; lineNumber++) {
      nextLineTops.push(editor.getTopForLineNumber(lineNumber));
    }

    setLineTops(nextLineTops);
    setContentHeight(editor.getContentHeight());
  }, []);

  const composeRawContent = useCallback((body: string) => {
    return `${frontmatterBlockRef.current}${body}`;
  }, []);

  const transformLoadContent = useCallback((content: string) => {
    return parseCalcSheetDocument(content).body;
  }, []);

  const editorConfig = useMemo(() => ({
    isActive: host.isActive,
    transformLoadContent,
    transformSaveContent: composeRawContent,
    editorOptions: {
      readOnly,
      fontSize: 15,
      lineHeight: editorLineHeight,
      fontFamily: "'SF Mono', 'Monaco', 'Menlo', 'Consolas', monospace",
      lineNumbers: 'on' as const,
      lineNumbersMinChars: 3,
      minimap: { enabled: false },
      glyphMargin: false,
      folding: false,
      lineDecorationsWidth: 18,
      renderLineHighlight: 'none' as const,
      renderWhitespace: 'none' as const,
      scrollBeyondLastLine: false,
      overviewRulerBorder: false,
      hideCursorInOverviewRuler: true,
      wordWrap: 'off' as const,
      tabSize: 2,
      guides: {
        indentation: false,
        highlightActiveIndentation: false,
      },
      padding: { top: 8, bottom: 8 },
    },
  }), [host.isActive, transformLoadContent, composeRawContent, readOnly]);

  const attachEditor = useCallback((wrapper: any) => {
    editorRef.current = wrapper;
    const editor = wrapper?.editor;
    const monaco = wrapper?.monaco;
    if (!editor || !monaco) return;

    contentListenerRef.current?.dispose();
    scrollListenerRef.current?.dispose();
    contentSizeListenerRef.current?.dispose();
    layoutListenerRef.current?.dispose();
    selectionListenerRef.current?.dispose();

    applyCalcSheetMonaco(editor, monaco, host.theme);
    refreshLayout(editor);
    if (gutterRef.current) {
      gutterRef.current.scrollTop = editor.getScrollTop();
    }

    contentListenerRef.current = editor.onDidChangeModelContent(() => {
      // In collab mode the model already holds the WHOLE file (frontmatter +
      // body), so use it verbatim; locally the model is body-only and the
      // frontmatter is re-prepended.
      const value = editor.getValue();
      setRawContent(collaborative ? value : composeRawContent(value));
      refreshLayout(editor);
      if (collaborative) applyFrontmatterHide(editor, monaco);
    });

    scrollListenerRef.current = editor.onDidScrollChange(() => {
      if (!gutterRef.current) return;
      gutterRef.current.scrollTop = editor.getScrollTop();
    });

    contentSizeListenerRef.current = editor.onDidContentSizeChange(() => {
      refreshLayout(editor);
    });

    layoutListenerRef.current = editor.onDidLayoutChange(() => {
      refreshLayout(editor);
    });

    const updateSelection = (selection: CalcSheetSelectionRange | null) => {
      const nextSelection = selection
        ? {
            startLineNumber: selection.startLineNumber,
            endLineNumber: selection.endLineNumber,
          }
        : null;
      setEditorSelection((currentSelection) => {
        if (
          currentSelection?.startLineNumber === nextSelection?.startLineNumber
          && currentSelection?.endLineNumber === nextSelection?.endLineNumber
        ) {
          return currentSelection;
        }
        return nextSelection;
      });
    };
    updateSelection(editor.getSelection());
    selectionListenerRef.current = editor.onDidChangeCursorSelection((event: { selection: CalcSheetSelectionRange }) => {
      updateSelection(event.selection);
    });
  }, [refreshLayout, composeRawContent, host.theme, collaborative, applyFrontmatterHide]);

  useEffect(() => {
    // In collab mode the binding (shared Y.Text) is the source of truth; a
    // local-file echo would clobber the synced content.
    if (collaborative) return;
    return host.onFileChanged((nextRawContent) => {
      setRawContent(nextRawContent);
    });
  }, [host, collaborative]);

  useEffect(() => {
    if (editorRef.current?.editor && editorRef.current?.monaco) {
      applyCalcSheetMonaco(editorRef.current.editor, editorRef.current.monaco, host.theme);
    }
  }, [host.theme, parsed]);

  if (rawContent === null && !loadError) {
    return <div className="calc-sheets calc-sheets--loading">Loading calc sheet...</div>;
  }

  if (loadError) {
    return (
      <div className="calc-sheets calc-sheets--error">
        Failed to load calc sheet: {loadError.message}
      </div>
    );
  }

  return (
    <div className="calc-sheets">
      {parsed.frontmatterError ? (
        <div className="calc-sheets__banner calc-sheets__banner--error">
          Frontmatter error: {parsed.frontmatterError}
        </div>
      ) : null}

      <div className="calc-sheets__surface">
        <div className="calc-sheets__editor">
          <MonacoEditor
            host={host}
            fileName={host.fileName}
            onEditorReady={attachEditor}
            config={editorConfig}
            collab={collabConfig}
          />
        </div>

        <div className="calc-sheets__gutter" ref={gutterRef} aria-hidden="true">
          <div
            className="calc-sheets__results"
            role="table"
            aria-label="Calculated results"
            style={{ height: Math.max(contentHeight, lineTops.length * editorLineHeight) }}
          >
            {parsed.lines.map((line) => {
              const output = evaluation.lineOutputs[line.index] || '';
              const className = [
                'calc-sheets__result-line',
                `calc-sheets__result-line--${line.kind}`,
                output.includes('ERR') || output.includes('FAIL')
                  ? 'calc-sheets__result-line--error'
                  : '',
              ]
                .filter(Boolean)
                .join(' ');

              return (
                <div
                  key={line.index}
                  className={className}
                  title={lineTitle(line, evaluation)}
                  style={{ top: lineTops[gutterLineOffset + line.index] ?? (gutterLineOffset + line.index) * editorLineHeight, height: editorLineHeight }}
                >
                  <span className="calc-sheets__result-value">
                    {line.kind === 'section' ? '' : output}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
