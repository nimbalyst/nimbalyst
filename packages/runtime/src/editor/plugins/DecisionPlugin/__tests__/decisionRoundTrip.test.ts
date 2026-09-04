// @vitest-environment node
/**
 * The decision fence through the real markdown pipeline.
 *
 * The failure this guards against is silent and total: if `DECISION_TRANSFORMER`
 * ever stops being ordered ahead of the core `CODE` transformer, every decision
 * in every document degrades to a YAML code block. Nothing throws, the document
 * still renders, and the sealed record stops being a decision. So the assertion
 * that matters is the node type, not the exported text.
 */

import { describe, expect, it } from "vitest";
import { $getRoot, type LexicalEditor } from "lexical";

import { $convertToEnhancedMarkdownString } from "../../../markdown/EnhancedMarkdownExport";
import { $convertFromEnhancedMarkdownString } from "../../../markdown/EnhancedMarkdownImport";
import {
  createTestEditor,
  MARKDOWN_TEST_TRANSFORMERS,
} from "../../DiffPlugin/__tests__/utils/testConfig";
import { $createDecisionNode, $isDecisionNode } from "../DecisionNode";
import { $regenerateDuplicateDecisionId } from "../../../extensions/builtin/DecisionExtension";

const DECISION_DOC = `Both shapes were prototyped against a 900px window.

\`\`\`decision
id: dcn-7f3a2c
ask: Which navigation model for the web console?
type: singleSelect
options:
  - id: gutter
    label: Icon gutter that expands to words
  - id: topbar
    label: Top bar with a project switcher
asked:
  - greg
  - karl
\`\`\`

Neither is reversible cheaply once the breadcrumb is built on top of it.`;

function importMarkdown(editor: LexicalEditor, markdown: string): void {
  editor.update(
    () => {
      $convertFromEnhancedMarkdownString(markdown, MARKDOWN_TEST_TRANSFORMERS);
    },
    { discrete: true }
  );
}

function exportMarkdown(editor: LexicalEditor): string {
  let exported = "";
  editor.update(
    () => {
      exported = $convertToEnhancedMarkdownString(MARKDOWN_TEST_TRANSFORMERS, {
        includeFrontmatter: false,
        shouldPreserveNewLines: true,
      });
    },
    { discrete: true }
  );
  return exported;
}

function decisionNodeContents(editor: LexicalEditor): string[] {
  const contents: string[] = [];
  editor.getEditorState().read(() => {
    for (const node of $getRoot().getChildren()) {
      if ($isDecisionNode(node)) contents.push(node.getContent());
    }
  });
  return contents;
}

describe("decision markdown round trip", () => {
  it("imports the fence as a DecisionNode, not a code block", () => {
    const editor = createTestEditor();
    importMarkdown(editor, DECISION_DOC);

    const contents = decisionNodeContents(editor);
    expect(contents).toHaveLength(1);
    expect(contents[0]).toContain("id: dcn-7f3a2c");
    expect(contents[0]).toContain("type: singleSelect");
  });

  it("survives a double round trip unchanged", () => {
    const editor = createTestEditor();
    importMarkdown(editor, DECISION_DOC);
    const firstExport = exportMarkdown(editor);

    expect(firstExport).toContain("```decision");

    const second = createTestEditor();
    importMarkdown(second, firstExport);
    expect(exportMarkdown(second)).toBe(firstExport);

    // The prose on either side of the block has to come back too -- a
    // multiline transformer that swallows a trailing paragraph is a real
    // failure mode for fenced blocks.
    expect(firstExport).toContain("prototyped against a 900px window");
    expect(firstExport).toContain("Neither is reversible cheaply");
  });

  it("keeps a sealed record verbatim through the editor", () => {
    // The node stores the fence body rather than a parsed object precisely so
    // this holds: whatever the file said comes back byte-identical, including
    // keys this version does not model.
    const sealed = `\`\`\`decision
id: dcn-7f3a2c
ask: Which navigation model?
type: singleSelect
options:
  - id: gutter
    label: Icon gutter
resolved: gutter
resolvedAt: "2026-09-04T14:22:00Z"
resolvedBy: greg
supersedes: dcn-001122
votes:
  - greg: gutter
\`\`\``;

    const editor = createTestEditor();
    importMarkdown(editor, sealed);

    expect(decisionNodeContents(editor)[0]).toContain("supersedes: dcn-001122");
    expect(exportMarkdown(editor).trim()).toBe(sealed);
  });

  it("regenerates the later id when a decision block is duplicated", () => {
    const editor = createTestEditor();
    editor.update(
      () => {
        const first = $createDecisionNode({
          content: "id: dcn-copy\nask: First\ntype: confirm",
        });
        const copy = $createDecisionNode({
          content: "id: dcn-copy\nask: Copy\ntype: confirm",
        });
        $getRoot().append(first, copy);
        $regenerateDuplicateDecisionId(copy);
      },
      { discrete: true }
    );

    const contents = decisionNodeContents(editor);
    expect(contents).toHaveLength(2);
    expect(contents[0]).toContain("id: dcn-copy");
    expect(contents[1]).toMatch(/id: dcn-[0-9a-f]{6}/);
    expect(contents[1]).not.toContain("id: dcn-copy");
  });
});
