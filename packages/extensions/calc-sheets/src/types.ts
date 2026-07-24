export interface CalcSheetDisplayConfig {
  decimals?: number;
}

export interface CalcSheetFrontmatter {
  title?: string;
  baseCurrency?: string;
  display?: CalcSheetDisplayConfig;
  units?: string[];
  fx?: {
    asOf?: string;
    rates?: Record<string, string | number>;
  };
}

export type CalcSheetLineKind =
  | 'blank'
  | 'comment'
  | 'section'
  | 'binding'
  | 'assert'
  | 'unknown';

export interface CalcFormatterSpec {
  name: string;
  args: string[];
}

export interface CalcSheetBinding {
  name: string;
  expression: string;
  formatter: CalcFormatterSpec | null;
}

export interface CalcSheetAssert {
  expression: string;
}

export interface CalcSheetLine {
  index: number;
  raw: string;
  kind: CalcSheetLineKind;
  sectionTitle?: string;
  binding?: CalcSheetBinding;
  assertion?: CalcSheetAssert;
  parseError?: string;
}

export interface ParsedCalcSheetDocument {
  frontmatter: CalcSheetFrontmatter;
  frontmatterBlock: string;
  body: string;
  lines: CalcSheetLine[];
  bodyStartLine: number;
  totalLineCount: number;
  frontmatterError: string | null;
}

export type BindingClassification = 'constant' | 'formula';

export interface EvaluatedBinding {
  name: string;
  value: unknown;
  formatted: string;
  classification: BindingClassification;
  dependencies: string[];
  error: string | null;
}

export interface EvaluatedAssertion {
  expression: string;
  passed: boolean;
  formatted: string;
  dependencies: string[];
  error: string | null;
}

export interface EvaluatedCalcSheet {
  bindings: Map<string, EvaluatedBinding>;
  assertions: EvaluatedAssertion[];
  lineOutputs: string[];
  errorCount: number;
}
