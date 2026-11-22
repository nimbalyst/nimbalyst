// @vitest-environment node
/**
 * Colored text is an inline `<span style="...">` in markdown (the form
 * Obsidian renders). It must import as a `text-color` element wrapping the
 * formatted text and come back out byte for byte, through the renderer's
 * transformer set and the headless one (collab worker, CLI, body seeding).
 */
import { describe, expect, it } from 'vitest';
import { createHeadlessEditor } from '@lexical/headless';
import {
  $createRangeSelection,
  $getRoot,
  $isElementNode,
  $isTextNode,
  $setSelection,
  type LexicalNode,
  type TextNode,
} from 'lexical';

import HeadlessBodyNodes from '../../../nodes/headlessBodyNodes';
import '../../../extensions/registerBuiltinExtensions';
import { getEditorTransformers } from '../../../markdown';
import { getHeadlessBodyTransformers } from '../../../markdown/headlessBodyTransformers';
import { $convertFromEnhancedMarkdownString } from '../../../markdown/EnhancedMarkdownImport';
import { $convertToEnhancedMarkdownString } from '../../../markdown/EnhancedMarkdownExport';
import { $setSelectionTextColor } from '../textColorActions';
import { lexicalYDocToMarkdown, markdownToLexicalYUpdate } from '../../../../sync/markdownYDoc';
import { TEXT_COLOR_PALETTE, type TextColorKind } from '../../../../core/textColorSyntax';

type Transformers = ReturnType<typeof getEditorTransformers>;

function describeTree(node: LexicalNode, depth = 0, out: string[] = []): string[] {
  const label = $isTextNode(node)
    ? `text${node.hasFormat('bold') ? '[bold]' : ''}${node.hasFormat('italic') ? '[italic]' : ''} ${JSON.stringify(node.getTextContent())}`
    : node.getType();
  out.push(`${'  '.repeat(depth)}${label}`);
  if ($isElementNode(node)) node.getChildren().forEach((child) => describeTree(child, depth + 1, out));
  return out;
}

function load(markdown: string, transformers: Transformers) {
  const errors: Error[] = [];
  const editor = createHeadlessEditor({
    namespace: 'text-color-round-trip',
    nodes: [...HeadlessBodyNodes],
    onError: (error: Error) => errors.push(error),
  });
  editor.update(() => {
    $convertFromEnhancedMarkdownString(markdown, transformers, undefined, true, false);
  }, { discrete: true });
  return { editor, errors };
}

function roundTrip(markdown: string, transformers: Transformers = getEditorTransformers()) {
  const { editor, errors } = load(markdown, transformers);
  return editor.getEditorState().read(() => ({
    markdown: $convertToEnhancedMarkdownString(transformers, { includeFrontmatter: false }),
    tree: describeTree($getRoot()).join('\n'),
    errors,
  }));
}

describe('colored text round-trips through markdown', () => {
  it('a palette color wrapping bold text imports as a text-color element and exports byte for byte', () => {
    const md = '<span style="color: #e03131">**Blocked** on review</span> and more';
    const { markdown, tree, errors } = roundTrip(md);
    expect(errors).toEqual([]);
    expect(markdown).toBe(md);
    expect(tree).toContain('  paragraph\n    text-color\n      text[bold] "Blocked"\n      text " on review"\n    text " and more"');
  });

  it.each([
    ['palette background', '<span style="background-color: #ffd43b4d">needs a look</span>'],
    ['palette color and background', 'Status: <span style="color: #228be6; background-color: #adb5bd4d">in *review*</span>.'],
    ['a link and code inside', '<span style="color: #2f9e44">see [the plan](https://example.com) and `npm test`</span>'],
    ['color inside bold', '**Done: <span style="color: #2f9e44">shipped</span>**'],
    ['nested spans', '<span style="background-color: #ffd43b4d">all <span style="color: #f03e3e">urgent</span> items</span>'],
    ['two spans in a list item', '- <span style="color: #f03e3e">red</span> and <span style="color: #845ef7">purple</span>'],
  ])('%s round-trips byte for byte', (_label, md) => {
    for (const transformers of [getEditorTransformers(), getHeadlessBodyTransformers()]) {
      const { markdown, tree, errors } = roundTrip(md, transformers);
      expect(errors).toEqual([]);
      expect(markdown).toBe(md);
      expect(tree).toContain('text-color');
    }
  });

  it('colors from elsewhere are kept exactly as written', () => {
    const md = [
      "<span style='color:rebeccapurple'>single quotes, named</span>",
      '',
      '<span style="background-color: rgb(255, 0, 0)">rgb</span> <span style="COLOR: #ABC;">upper</span>',
    ].join('\n');
    const { markdown, tree, errors } = roundTrip(md);
    expect(errors).toEqual([]);
    expect(markdown).toBe(md);
    expect(tree.match(/text-color/g)).toHaveLength(3);
  });

  it('survives a trip through the collaborative Y.Doc unchanged', () => {
    const md = [
      'Status: <span style="color: #f03e3e">**Blocked** on [review](https://example.com)</span>',
      '',
      "<span style='background-color: hsl(50, 100%, 80%)'>hand written</span>",
    ].join('\n');
    expect(lexicalYDocToMarkdown(markdownToLexicalYUpdate(md)).trim()).toBe(md);
  });

  it('a span with anything besides color stays literal text', () => {
    for (const md of [
      '<span style="color: red; font-size: 40px">big</span>',
      '<span class="x" style="color: red">classed</span>',
      '<span style="color: url(x)">bad value</span>',
      '<span style="color: red">never closed',
    ]) {
      const { markdown, tree } = roundTrip(md);
      expect(tree).not.toContain('text-color');
      expect(markdown).toBe(md);
    }
  });
});

function $findText(text: string): TextNode {
  const found = $getRoot().getAllTextNodes().find((node) => node.getTextContent().includes(text));
  if (!found) throw new Error(`no text node containing ${text}`);
  return found;
}

/** Select `text` (inside one text node), set a color, and return the saved markdown. */
function applyColor(md: string, text: string, kind: TextColorKind, value: string | null, collapsed = false): string {
  const transformers = getEditorTransformers();
  const { editor, errors } = load(md, transformers);
  let changed = false;
  editor.update(() => {
    const node = $findText(text);
    const offset = node.getTextContent().indexOf(text);
    const selection = $createRangeSelection();
    selection.anchor.set(node.getKey(), offset, 'text');
    selection.focus.set(node.getKey(), collapsed ? offset : offset + text.length, 'text');
    $setSelection(selection);
    changed = $setSelectionTextColor(kind, value);
  }, { discrete: true });
  expect(errors).toEqual([]);
  expect(changed).toBe(true);
  return editor.getEditorState().read(() => $convertToEnhancedMarkdownString(transformers, { includeFrontmatter: false }));
}

describe('setting colors from the toolbar', () => {
  const red = TEXT_COLOR_PALETTE.find((entry) => entry.name === 'red')!;
  const yellow = TEXT_COLOR_PALETTE.find((entry) => entry.name === 'yellow')!;

  it('wraps the selection, including bold inside it, in one span', () => {
    expect(applyColor('Release **blocked** on review today', 'blocked', 'color', red.color))
      .toBe(`Release <span style="color: ${red.color}">**blocked**</span> on review today`);
  });

  it('adds a background to colored text in the same span', () => {
    const md = `<span style="color: ${red.color}">late</span>`;
    expect(applyColor(md, 'late', 'background', yellow.background))
      .toBe(`<span style="color: ${red.color}; background-color: ${yellow.background}">late</span>`);
  });

  it('"none" on a caret inside colored text unwraps the whole span', () => {
    const md = `Ship <span style="color: ${red.color}">**now** please</span> ok`;
    expect(applyColor(md, 'please', 'color', null, true)).toBe('Ship **now** please ok');
  });

  it('"none" on part of a span keeps the rest colored with its original tag', () => {
    const md = "<span style='color:teal'>keep this part</span>";
    expect(applyColor(md, 'this part', 'color', null))
      .toBe("<span style='color:teal'>keep </span>this part");
  });

  it('recoloring part of a span splits it', () => {
    const md = `<span style="color: ${red.color}">one two</span>`;
    const blue = TEXT_COLOR_PALETTE.find((entry) => entry.name === 'blue')!;
    expect(applyColor(md, 'two', 'color', blue.color))
      .toBe(`<span style="color: ${red.color}">one </span><span style="color: ${blue.color}">two</span>`);
  });
});

/** Select from the start of the text node containing `from` to the end of the one containing `to`, set a color, and return the saved markdown. */
function applyColorAcross(md: string, from: string, to: string, kind: TextColorKind, value: string | null): string {
  const transformers = getEditorTransformers();
  const { editor, errors } = load(md, transformers);
  editor.update(() => {
    const first = $findText(from);
    const last = $findText(to);
    const selection = $createRangeSelection();
    selection.anchor.set(first.getKey(), 0, 'text');
    selection.focus.set(last.getKey(), last.getTextContentSize(), 'text');
    $setSelection(selection);
    expect($setSelectionTextColor(kind, value)).toBe(true);
  }, { discrete: true });
  expect(errors).toEqual([]);
  return editor.getEditorState().read(() => $convertToEnhancedMarkdownString(transformers, { includeFrontmatter: false }));
}

describe('a color change leaves other colors alone', () => {
  const red = TEXT_COLOR_PALETTE.find((entry) => entry.name === 'red')!;
  const blue = TEXT_COLOR_PALETTE.find((entry) => entry.name === 'blue')!;
  const yellow = TEXT_COLOR_PALETTE.find((entry) => entry.name === 'yellow')!;
  const link = `[<span style="color: ${red.color}">a</span><span style='color:${red.color}'>b</span><span style="color: ${blue.color}">c</span>](https://example.com)`;

  it('coloring other text keeps a link whose spans differ in color and spelling', () => {
    expect(applyColor(`${link} and more`, 'more', 'color', yellow.color))
      .toBe(`${link} and <span style="color: ${yellow.color}">more</span>`);
  });

  it('a background across such a link keeps each leaf\'s own text color', () => {
    const out = applyColorAcross(`${link} and more`, 'a', 'c', 'background', yellow.background);
    const { tree } = roundTrip(out);
    expect(out).toContain(`color: ${blue.color}; background-color: ${yellow.background}">c</span>`);
    expect(tree.match(/text-color/g)!.length).toBeGreaterThanOrEqual(2);
  });

  it('coloring another word keeps adjacent spans as written', () => {
    const md = `<span style='color:teal'>a</span><span style="color:teal">b</span> and more`;
    expect(applyColor(md, 'more', 'color', red.color))
      .toBe(`<span style='color:teal'>a</span><span style="color:teal">b</span> and <span style="color: ${red.color}">more</span>`);
  });

  it('recoloring inside one span keeps a differently spelled neighbour separate', () => {
    const md = `<span style='color:teal'>a</span><span style="color:teal">bc</span>`;
    expect(applyColor(md, 'c', 'background', yellow.background))
      .toBe(`<span style='color:teal'>a</span><span style="color:teal">b</span><span style="color: teal; background-color: ${yellow.background}">c</span>`);
  });

  it('a nested span outside the selection keeps its structure', () => {
    const md = `<span style="background-color: ${yellow.background}">all <span style="color: ${red.color}">urgent</span> items</span> and more`;
    expect(applyColor(md, 'more', 'color', blue.color))
      .toBe(`<span style="background-color: ${yellow.background}">all <span style="color: ${red.color}">urgent</span> items</span> and <span style="color: ${blue.color}">more</span>`);
  });
});

describe('literal span tags', () => {
  it('an escaped span stays literal through two load and save cycles', () => {
    const md = String.raw`\<span style="color:teal">example</span> text`;
    const first = roundTrip(md);
    expect(first.tree).not.toContain('text-color');
    const second = roundTrip(first.markdown);
    expect(second.tree).not.toContain('text-color');
    expect(second.tree).toContain('<span style=\\"color:teal\\">example</span> text');
    expect(roundTrip(second.markdown).markdown).toBe(second.markdown);
  });

  it('an escaped span inside bold stays literal through two cycles', () => {
    const md = String.raw`**\<span style="color:teal">bold</span>** after`;
    const second = roundTrip(roundTrip(md).markdown);
    expect(second.tree).not.toContain('text-color');
  });

  it('an unclosed literal span is not escaped on save', () => {
    const md = '<span style="color: red">never closed';
    expect(roundTrip(md).markdown).toBe(md);
  });

  it.each([
    ['a closing tag in code', '<span style="color: teal">use `</span>` here</span> after'],
    ['an opening tag in code', '<span style="color: teal">use `<span style="color: red">` here</span> after'],
    ['an escaped closing tag', String.raw`<span style="color: teal">use \</span> here</span> after`],
  ])('%s does not end or nest the colored span', (_label, md) => {
    const { markdown, tree, errors } = roundTrip(md);
    expect(errors).toEqual([]);
    expect(tree.match(/text-color/g)).toHaveLength(1);
    expect(tree).toContain('text " after"');
    expect(markdown).toBe(md);
  });
});
