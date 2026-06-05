import type { editor as MonacoEditorType, languages, Monaco } from 'monaco-editor';
import { tokenizeCalcSheetLine, type CalcSheetSyntaxTokenKind } from './calcSheetSyntax';

const CALC_SHEET_LANGUAGE_ID = 'calc-sheet';
const CALC_SHEET_LIGHT_THEME = 'calc-sheet-light';
const CALC_SHEET_DARK_THEME = 'calc-sheet-dark';

const TOKEN_SCOPE_BY_KIND: Record<CalcSheetSyntaxTokenKind, string> = {
  comment: 'calc.comment',
  'heading-marker': 'calc.heading.marker',
  'heading-text': 'calc.heading.text',
  keyword: 'calc.keyword',
  'variable-definition': 'calc.variable.definition',
  variable: 'calc.variable',
  unit: 'calc.unit',
  function: 'calc.function',
  formatter: 'calc.formatter',
  number: 'calc.number',
  operator: 'calc.operator',
};

const EMPTY_STATE: languages.IState = {
  clone() {
    return this;
  },
  equals(other: languages.IState) {
    return other === this;
  },
};

function isDarkTheme(theme: string | undefined): boolean {
  return theme === 'dark' || theme === 'crystal-dark';
}

function registerCalcSheetLanguage(monaco: Monaco): void {
  const registered = monaco.languages.getLanguages().some((entry) => entry.id === CALC_SHEET_LANGUAGE_ID);
  if (!registered) {
    monaco.languages.register({ id: CALC_SHEET_LANGUAGE_ID });
    monaco.languages.setTokensProvider(CALC_SHEET_LANGUAGE_ID, {
      getInitialState: () => EMPTY_STATE,
      tokenize(line: string) {
        const ranges = tokenizeCalcSheetLine(line);
        const tokens: languages.IToken[] = [];
        let cursor = 0;

        for (const range of ranges) {
          if (range.start > cursor) {
            tokens.push({ startIndex: cursor, scopes: 'calc.text' });
          }
          tokens.push({
            startIndex: range.start,
            scopes: TOKEN_SCOPE_BY_KIND[range.kind],
          });
          cursor = range.end;
        }

        if (cursor < line.length) {
          tokens.push({ startIndex: cursor, scopes: 'calc.text' });
        }

        if (tokens.length === 0) {
          tokens.push({ startIndex: 0, scopes: 'calc.text' });
        }

        return {
          endState: EMPTY_STATE,
          tokens,
        };
      },
    });
  }

  monaco.editor.defineTheme(CALC_SHEET_LIGHT_THEME, {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'calc.comment', foreground: '8e7d52', fontStyle: 'italic' },
      { token: 'calc.heading.marker', foreground: 'a57121', fontStyle: 'bold' },
      { token: 'calc.heading.text', foreground: '7a3e14', fontStyle: 'bold' },
      { token: 'calc.keyword', foreground: '9a2f45', fontStyle: 'bold' },
      { token: 'calc.variable.definition', foreground: '7a2b8f', fontStyle: 'bold' },
      { token: 'calc.variable', foreground: '5a3dc2' },
      { token: 'calc.unit', foreground: '0f6d6d' },
      { token: 'calc.function', foreground: '8a5420' },
      { token: 'calc.formatter', foreground: 'c04b1f', fontStyle: 'bold' },
      { token: 'calc.number', foreground: '245f9b' },
      { token: 'calc.operator', foreground: '7c6a3e' },
    ],
    colors: {},
  });

  monaco.editor.defineTheme(CALC_SHEET_DARK_THEME, {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'calc.comment', foreground: 'bba56f', fontStyle: 'italic' },
      { token: 'calc.heading.marker', foreground: 'f0b35b', fontStyle: 'bold' },
      { token: 'calc.heading.text', foreground: 'ffd9a3', fontStyle: 'bold' },
      { token: 'calc.keyword', foreground: 'ff8fb0', fontStyle: 'bold' },
      { token: 'calc.variable.definition', foreground: 'f1a8ff', fontStyle: 'bold' },
      { token: 'calc.variable', foreground: 'bda6ff' },
      { token: 'calc.unit', foreground: '78d9d0' },
      { token: 'calc.function', foreground: 'f7c47d' },
      { token: 'calc.formatter', foreground: 'ffad7b', fontStyle: 'bold' },
      { token: 'calc.number', foreground: '93c7ff' },
      { token: 'calc.operator', foreground: 'dac58d' },
    ],
    colors: {},
  });
}

export function applyCalcSheetMonaco(
  editor: MonacoEditorType.IStandaloneCodeEditor,
  monaco: Monaco,
  theme: string | undefined,
): void {
  registerCalcSheetLanguage(monaco);

  const model = editor.getModel();
  if (model && model.getLanguageId() !== CALC_SHEET_LANGUAGE_ID) {
    monaco.editor.setModelLanguage(model, CALC_SHEET_LANGUAGE_ID);
  }

  monaco.editor.setTheme(isDarkTheme(theme) ? CALC_SHEET_DARK_THEME : CALC_SHEET_LIGHT_THEME);
}
