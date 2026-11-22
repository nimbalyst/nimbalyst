// @vitest-environment node
/**
 * Every main-process child_process call that runs `git` must pass
 * `windowsHide: true` (#1839). Without it, Windows opens a console window for
 * each background `git status` / `ls-files` / `rev-parse`, which flashes and
 * steals focus several times a minute while a repo is open.
 *
 * This walks the main-process sources with the TypeScript parser rather than
 * exercising each helper, because the failure is "someone added a git call and
 * forgot the flag", and no per-helper test would notice a new callsite.
 * simple-git already sets the flag itself, so only raw child_process calls are
 * checked.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import ts from 'typescript';

const MAIN_DIR = join(__dirname, '..', '..');
const CHILD_PROCESS_FUNCTIONS = new Set(['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync']);

function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === '__tests__' || name === 'testSupport' || name === 'node_modules') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) listSourceFiles(full, out);
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts') && !name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

/** Local names bound to child_process functions, including `promisify(execFile)` aliases. */
function childProcessBindings(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (
      ts.isImportDeclaration(statement)
      && ts.isStringLiteral(statement.moduleSpecifier)
      && /^(node:)?child_process$/.test(statement.moduleSpecifier.text)
    ) {
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const imported = (element.propertyName ?? element.name).text;
          if (CHILD_PROCESS_FUNCTIONS.has(imported)) names.add(element.name.text);
        }
      }
    }
  }
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer
      && ts.isCallExpression(node.initializer)
      && ts.isIdentifier(node.initializer.expression)
      && node.initializer.expression.text === 'promisify'
      && node.initializer.arguments.some((arg) => ts.isIdentifier(arg) && names.has(arg.text))
    ) {
      names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

function runsGit(arg: ts.Expression | undefined): boolean {
  if (!arg) return false;
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
    return arg.text === 'git' || arg.text.startsWith('git ');
  }
  if (ts.isTemplateExpression(arg)) return arg.head.text.startsWith('git ');
  return false;
}

function hasWindowsHide(call: ts.CallExpression): boolean {
  return call.arguments.some((arg) =>
    ts.isObjectLiteralExpression(arg)
    && arg.properties.some((prop) =>
      ts.isPropertyAssignment(prop)
      && ts.isIdentifier(prop.name)
      && prop.name.text === 'windowsHide'
      && prop.initializer.kind === ts.SyntaxKind.TrueKeyword));
}

describe('main-process git child processes', () => {
  it('pass windowsHide: true so Windows does not flash a console window', () => {
    const gitCalls: string[] = [];
    const missing: string[] = [];

    for (const file of listSourceFiles(MAIN_DIR)) {
      const text = readFileSync(file, 'utf8');
      if (!text.includes('child_process')) continue;
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
      const bindings = childProcessBindings(source);
      if (bindings.size === 0) continue;

      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node)
          && ts.isIdentifier(node.expression)
          && bindings.has(node.expression.text)
          && runsGit(node.arguments[0])
        ) {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart());
          const where = `${relative(MAIN_DIR, file)}:${line + 1}`;
          gitCalls.push(where);
          if (!hasWindowsHide(node)) missing.push(where);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }

    // Guards against the walker silently matching nothing.
    expect(gitCalls.length).toBeGreaterThan(20);
    expect(missing).toEqual([]);
  });
});
