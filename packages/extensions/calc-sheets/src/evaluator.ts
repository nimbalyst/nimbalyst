import { all, create } from 'mathjs';
import type {
  BindingClassification,
  CalcFormatterSpec,
  CalcSheetBinding,
  CalcSheetFrontmatter,
  CalcSheetLine,
  EvaluatedAssertion,
  EvaluatedBinding,
  EvaluatedCalcSheet,
} from './types';

type MathInstance = ReturnType<typeof create>;

function isIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function safeCreateUnit(math: MathInstance, name: string, definition?: string): void {
  try {
    if (definition) {
      math.createUnit(name, { definition, aliases: [name.toLowerCase()] });
    } else {
      math.createUnit(name, { aliases: [name.toLowerCase()] });
    }
  } catch {
    // Ignore duplicate or invalid unit registration. The editor still
    // surfaces expression-level errors where it matters.
  }
}

function normalizeExpressionSyntax(expression: string): string {
  let index = 0;
  let output = '';

  while (index < expression.length) {
    const match = expression.slice(index).match(/\bto\s*\(/);
    if (!match || match.index === undefined) {
      output += expression.slice(index);
      break;
    }

    const absoluteStart = index + match.index;
    output += expression.slice(index, absoluteStart);

    const callStart = absoluteStart + match[0].length;
    let cursor = callStart;
    let depth = 1;
    let inString = false;

    while (cursor < expression.length && depth > 0) {
      const char = expression[cursor];
      if (char === '"' && expression[cursor - 1] !== '\\') {
        inString = !inString;
      } else if (!inString && char === '(') {
        depth++;
      } else if (!inString && char === ')') {
        depth--;
      }
      cursor++;
    }

    if (depth !== 0) {
      output += expression.slice(absoluteStart);
      break;
    }

    const callContent = expression.slice(callStart, cursor - 1);
    let commaIndex = -1;
    let nestedDepth = 0;
    inString = false;
    for (let i = 0; i < callContent.length; i++) {
      const char = callContent[i];
      if (char === '"' && callContent[i - 1] !== '\\') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (char === '(' || char === '[' || char === '{') nestedDepth++;
      if (char === ')' || char === ']' || char === '}') nestedDepth--;
      if (nestedDepth === 0 && char === ',') {
        commaIndex = i;
        break;
      }
    }

    if (commaIndex === -1) {
      output += expression.slice(absoluteStart, cursor);
      index = cursor;
      continue;
    }

    const left = callContent.slice(0, commaIndex).trimEnd();
    const right = callContent.slice(commaIndex + 1).trim();
    const normalizedRight = isIdentifier(right) ? `"${right}"` : right;
    output += `to(${left}, ${normalizedRight})`;
    index = cursor;
  }

  return output;
}

function createMath(frontmatter: CalcSheetFrontmatter): MathInstance {
  const math = create(all, {
    number: 'number',
    precision: 32,
  });

  const baseCurrency = (frontmatter.baseCurrency || 'USD').toUpperCase();
  safeCreateUnit(math, baseCurrency);

  const rates = frontmatter.fx?.rates || {};
  for (const [currencyName, rate] of Object.entries(rates)) {
    const code = currencyName.toUpperCase();
    if (typeof rate === 'number') {
      safeCreateUnit(math, code, `${rate} ${baseCurrency}`);
      continue;
    }

    const raw = rate.trim();
    if (/^[0-9.]+$/.test(raw)) {
      safeCreateUnit(math, code, `${raw} ${baseCurrency}`);
    } else {
      safeCreateUnit(math, code, raw);
    }
  }

  for (const unitName of frontmatter.units || []) {
    if (isIdentifier(unitName)) {
      safeCreateUnit(math, unitName);
    }
  }

  math.import({
    to(value: any, unitName: string) {
      const target = stripQuotes(String(unitName));
      if (value && typeof value.to === 'function') {
        return value.to(target);
      }
      throw new Error(`Cannot convert value to ${target}`);
    },
  }, { override: true });

  return math;
}

function collectSymbols(math: MathInstance, expression: string): string[] {
  try {
    const symbols = new Set<string>();
    const node = math.parse(normalizeExpressionSyntax(expression));
    node.traverse((child: any) => {
      if (child && child.isSymbolNode && typeof child.name === 'string') {
        symbols.add(child.name);
      }
    });
    return Array.from(symbols);
  } catch {
    return [];
  }
}

function displayDecimals(frontmatter: CalcSheetFrontmatter): number {
  return frontmatter.display?.decimals ?? 2;
}

function isMathUnit(value: unknown): value is { formatUnits?: () => string; to?: (unit: string) => unknown; value?: unknown } {
  return Boolean(
    value &&
    typeof value === 'object' &&
    ('formatUnits' in value || 'to' in value)
  );
}

function parseIntegerArg(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(stripQuotes(raw), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatNumber(value: number, decimals: number, minimumFractionDigits = 0): string {
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits,
    maximumFractionDigits: decimals,
  }).format(value);
}

function formatCurrencyValue(value: unknown, unitName: string, decimals: number): string {
  const code = unitName.toUpperCase();
  const formatter = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: code,
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });

  if (isMathUnit(value) && typeof value.to === 'function') {
    const converted = value.to(code) as any;
    const numeric = typeof converted?.toNumber === 'function'
      ? converted.toNumber(code)
      : Number(converted?.value ?? converted);
    if (Number.isFinite(numeric)) {
      return formatter.format(numeric);
    }
  }

  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return formatter.format(numeric);
  }

  return String(value);
}

function formatDefault(value: unknown, frontmatter: CalcSheetFrontmatter): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') {
    return formatNumber(value, displayDecimals(frontmatter));
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (isMathUnit(value)) {
    const unitName = typeof value.formatUnits === 'function' ? value.formatUnits() : '';
    if (/^[A-Z]{3}$/.test(unitName)) {
      return formatCurrencyValue(value, unitName, displayDecimals(frontmatter));
    }
    if (typeof (value as any).format === 'function') {
      return (value as any).format({
        precision: Math.max(displayDecimals(frontmatter), 6),
      });
    }
  }
  return String(value);
}

function formatWithFormatter(
  value: unknown,
  formatter: CalcFormatterSpec | null,
  frontmatter: CalcSheetFrontmatter,
): string {
  if (!formatter) {
    return formatDefault(value, frontmatter);
  }

  switch (formatter.name) {
    case 'currency': {
      const unitName = stripQuotes(
        formatter.args[0] || frontmatter.baseCurrency || 'USD',
      );
      const decimals = parseIntegerArg(
        formatter.args[1],
        displayDecimals(frontmatter),
      );
      return formatCurrencyValue(value, unitName, decimals);
    }
    case 'percent': {
      const decimals = parseIntegerArg(
        formatter.args[0],
        displayDecimals(frontmatter),
      );
      const numeric = typeof value === 'number'
        ? value
        : Number((value as any)?.value ?? value);
      if (Number.isFinite(numeric)) {
        return `${formatNumber(numeric * 100, decimals, decimals)}%`;
      }
      return String(value);
    }
    case 'number': {
      const decimals = parseIntegerArg(
        formatter.args[0],
        displayDecimals(frontmatter),
      );
      const numeric = typeof value === 'number'
        ? value
        : Number((value as any)?.value ?? value);
      if (Number.isFinite(numeric)) {
        return formatNumber(numeric, decimals);
      }
      return String(value);
    }
    default:
      return formatDefault(value, frontmatter);
  }
}

function buildBindingGraph(
  math: MathInstance,
  lines: CalcSheetLine[],
): Map<string, { binding: CalcSheetBinding; lineIndex: number; dependencies: string[] }> {
  const bindings = new Map<string, { binding: CalcSheetBinding; lineIndex: number; dependencies: string[] }>();
  const bindingNames = new Set<string>();

  for (const line of lines) {
    if (line.kind === 'binding' && line.binding) {
      bindingNames.add(line.binding.name);
    }
  }

  for (const line of lines) {
    if (line.kind !== 'binding' || !line.binding) continue;
    const dependencies = collectSymbols(math, line.binding.expression).filter(
      (symbol) => bindingNames.has(symbol) && symbol !== line.binding?.name,
    );
    bindings.set(line.binding.name, {
      binding: line.binding,
      lineIndex: line.index,
      dependencies: Array.from(new Set(dependencies)),
    });
  }

  return bindings;
}

export function evaluateCalcSheet(
  lines: CalcSheetLine[],
  frontmatter: CalcSheetFrontmatter,
  totalLineCount?: number,
): EvaluatedCalcSheet {
  const math = createMath(frontmatter);
  const graph = buildBindingGraph(math, lines);
  const bindingCache = new Map<string, EvaluatedBinding>();
  const highestLineIndex = lines.reduce((max, line) => Math.max(max, line.index), -1);
  const outputLength = totalLineCount ?? highestLineIndex + 1;
  const lineOutputs = Array.from({ length: outputLength }, () => '');
  let errorCount = 0;

  const evaluateBinding = (name: string, stack: string[] = []): EvaluatedBinding => {
    const cached = bindingCache.get(name);
    if (cached) return cached;

    const node = graph.get(name);
    if (!node) {
      const missing: EvaluatedBinding = {
        name,
        value: null,
        formatted: '',
        classification: 'constant',
        dependencies: [],
        error: `Unknown binding: ${name}`,
      };
      errorCount++;
      bindingCache.set(name, missing);
      return missing;
    }

    if (stack.includes(name)) {
      const cycle: EvaluatedBinding = {
        name,
        value: null,
        formatted: 'ERR cycle',
        classification: 'formula',
        dependencies: node.dependencies,
        error: `Circular dependency: ${[...stack, name].join(' -> ')}`,
      };
      errorCount++;
      bindingCache.set(name, cycle);
      return cycle;
    }

    const scope: Record<string, unknown> = {};
    let dependencyError: string | null = null;
    for (const dependencyName of node.dependencies) {
      const dependency = evaluateBinding(dependencyName, [...stack, name]);
      if (dependency.error) {
        dependencyError = dependency.error;
      } else {
        scope[dependencyName] = dependency.value;
      }
    }

    if (dependencyError) {
      const failed: EvaluatedBinding = {
        name,
        value: null,
        formatted: 'ERR',
        classification: node.dependencies.length > 0 ? 'formula' : 'constant',
        dependencies: node.dependencies,
        error: dependencyError,
      };
      errorCount++;
      bindingCache.set(name, failed);
      return failed;
    }

    try {
      const value = math.evaluate(normalizeExpressionSyntax(node.binding.expression), scope);
      const classification: BindingClassification =
        node.dependencies.length === 0 ? 'constant' : 'formula';
      const formatted = formatWithFormatter(value, node.binding.formatter, frontmatter);
      const evaluated: EvaluatedBinding = {
        name,
        value,
        formatted,
        classification,
        dependencies: node.dependencies,
        error: null,
      };
      bindingCache.set(name, evaluated);
      return evaluated;
    } catch (error) {
      const failed: EvaluatedBinding = {
        name,
        value: null,
        formatted: 'ERR',
        classification: node.dependencies.length > 0 ? 'formula' : 'constant',
        dependencies: node.dependencies,
        error: error instanceof Error ? error.message : 'Evaluation failed',
      };
      errorCount++;
      bindingCache.set(name, failed);
      return failed;
    }
  };

  for (const name of graph.keys()) {
    evaluateBinding(name);
  }

  const assertions: EvaluatedAssertion[] = [];
  for (const line of lines) {
    if (line.kind === 'binding' && line.binding) {
      const evaluated = bindingCache.get(line.binding.name);
      if (!evaluated) continue;
      lineOutputs[line.index] = evaluated.formatted || (evaluated.error ? 'ERR' : '');
      continue;
    }

    if (line.kind === 'assert' && line.assertion) {
      const dependencies = collectSymbols(math, line.assertion.expression).filter(
        (symbol) => graph.has(symbol),
      );
      const scope: Record<string, unknown> = {};
      let dependencyError: string | null = null;
      for (const dependencyName of dependencies) {
        const evaluated = bindingCache.get(dependencyName) || evaluateBinding(dependencyName);
        if (evaluated.error) {
          dependencyError = evaluated.error;
          break;
        }
        scope[dependencyName] = evaluated.value;
      }

      let assertion: EvaluatedAssertion;
      if (dependencyError) {
        assertion = {
          expression: line.assertion.expression,
          passed: false,
          formatted: 'ASSERT ERR',
          dependencies,
          error: dependencyError,
        };
        errorCount++;
      } else {
        try {
          const value = math.evaluate(normalizeExpressionSyntax(line.assertion.expression), scope);
          const passed = Boolean(value);
          assertion = {
            expression: line.assertion.expression,
            passed,
            formatted: passed ? 'ASSERT OK' : 'ASSERT FAIL',
            dependencies,
            error: passed ? null : 'Assertion failed',
          };
          if (!passed) {
            errorCount++;
          }
        } catch (error) {
          assertion = {
            expression: line.assertion.expression,
            passed: false,
            formatted: 'ASSERT ERR',
            dependencies,
            error: error instanceof Error ? error.message : 'Assertion failed',
          };
          errorCount++;
        }
      }

      assertions.push(assertion);
      lineOutputs[line.index] = assertion.formatted;
      continue;
    }

    if (line.kind === 'unknown') {
      lineOutputs[line.index] = 'PARSE ERR';
      errorCount++;
    }
  }

  return {
    bindings: bindingCache,
    assertions,
    lineOutputs,
    errorCount,
  };
}
