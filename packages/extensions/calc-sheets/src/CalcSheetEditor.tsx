import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { IDisposable } from 'monaco-editor';
import type { EditorHostProps } from '@nimbalyst/extension-sdk';
import { MonacoEditor } from '@nimbalyst/runtime';
import { applyCalcSheetMonaco } from './calcSheetMonaco';
import { evaluateCalcSheet } from './evaluator';
import { parseCalcSheetDocument } from './parser';

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
  const frontmatterBlockRef = useRef('');
  const [lineTops, setLineTops] = useState<number[]>([]);
  const [contentHeight, setContentHeight] = useState(0);
  const editorLineHeight = 30;

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
    };
  }, []);

  const parsed = useMemo(() => parseCalcSheetDocument(rawContent ?? ''), [rawContent]);
  frontmatterBlockRef.current = parsed.frontmatterBlock;

  const evaluation = useMemo(
    () => evaluateCalcSheet(parsed.lines, parsed.frontmatter, parsed.lines.length),
    [parsed],
  );

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

    applyCalcSheetMonaco(editor, monaco, host.theme);
    refreshLayout(editor);
    if (gutterRef.current) {
      gutterRef.current.scrollTop = editor.getScrollTop();
    }

    contentListenerRef.current = editor.onDidChangeModelContent(() => {
      setRawContent(composeRawContent(editor.getValue()));
      refreshLayout(editor);
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
  }, [refreshLayout, composeRawContent, host.theme]);

  useEffect(() => {
    return host.onFileChanged((nextRawContent) => {
      setRawContent(nextRawContent);
    });
  }, [host]);

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
                  style={{ top: lineTops[line.index] ?? line.index * editorLineHeight, height: editorLineHeight }}
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
