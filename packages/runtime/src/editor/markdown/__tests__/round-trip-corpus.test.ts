import {describe, expect, it} from 'vitest';
import {
  $getRoot,
  $getSelection,
  $isElementNode,
  $selectAll,
  type ElementNode,
  type LexicalEditor,
} from 'lexical';

import {
  $convertNodeToEnhancedMarkdownString,
  $convertSelectionToEnhancedMarkdownString,
  $convertToEnhancedMarkdownString,
} from '../EnhancedMarkdownExport';
import {$convertFromEnhancedMarkdownString} from '../EnhancedMarkdownImport';
import {
  createTestEditor,
  MARKDOWN_TEST_TRANSFORMERS,
} from '../../plugins/DiffPlugin/__tests__/utils/testConfig';

type RoundTripOptions = {
  includeFrontmatter?: boolean;
};

function createMarkdownEditor(): LexicalEditor {
  return createTestEditor();
}

function exportMarkdown(
  editor: LexicalEditor,
  options: RoundTripOptions = {},
): string {
  let exported = '';

  editor.update(
    () => {
      exported = $convertToEnhancedMarkdownString(MARKDOWN_TEST_TRANSFORMERS, {
        includeFrontmatter: options.includeFrontmatter ?? false,
        shouldPreserveNewLines: true,
      });
    },
    {discrete: true},
  );

  return exported;
}

function importMarkdown(
  editor: LexicalEditor,
  markdown: string,
): void {
  editor.update(
    () => {
      $convertFromEnhancedMarkdownString(markdown, MARKDOWN_TEST_TRANSFORMERS);
    },
    {discrete: true},
  );
}

function roundTripOnce(
  markdown: string,
  options: RoundTripOptions = {},
): string {
  const editor = createMarkdownEditor();
  importMarkdown(editor, markdown);
  return exportMarkdown(editor, options);
}

function doubleRoundTrip(
  markdown: string,
  options: RoundTripOptions = {},
): {firstExport: string; secondExport: string} {
  const firstExport = roundTripOnce(markdown, options);
  const secondExport = roundTripOnce(firstExport, options);
  return {firstExport, secondExport};
}

const TRACKER_STRATEGY_PROBLEM_EXCERPT = `| Enterprise team on Jira | Native + Jira | Native for internal RFCs/decisions, Jira for the issues their org tracks centrally |
| Startup using Linear | Native + Linear | Linear as primary work tracker, native for design docs and decisions |
| Team running multiple repos | Native + GitHub Issues x N | Per-repo binding; provider can be configured for multiple repos |
| Team on self-hosted Gitea | Native + Gitea (marketplace) | Same provider contract as GitHub; just a different extension |
| Nimbalyst itself | Native + GitHub Issues + Linear | Our specific configuration - see "Nimbalyst's configuration" below |

**What's**** ****per-workspace**** ****configurable:**

## What capabilities exist today

### Extension contribution surface
From \`packages/extension-sdk/src/types/extension.ts\`:
- \`customEditors\` - file-type-bound editors
- \`aiTools\` - extensions register MCP-style tools surfaced to the agent
- \`panels\` - sidebar / bottom-panel / non-file-based UIs

### Architectural (universal)

| Choice | Decision |
| --- | --- |
| **Provider mechanism** | **All foreign trackers are \\****\`TrackerProvider\`**\\*\\** extensions.** Native is the only built-in. Distribution channels can pre-install some providers, but architecturally there is no "bundled" tier with privileged capability - the contract is the same for everyone. |
| **Session linking** | **URN-based, switched in Phase 1.** Native links migrate to \`nimbalyst://NIM-xxx\` in the same change as the contract; foreign providers slot in cleanly afterward. |

### Agent commit-message instructions

**Per-provider**** ****\\****syntax***\\******* ******\\****declaration,***\\******* ******\\****not***\\******* ******\\****hardcoded.** This matters for multi-tenant use: a workspace using Jira needs \`Fixes PROJ-42\`, a workspace using YouTrack needs something else, and core doesn't know about either. Each \`TrackerProvider\` declares its commit syntax in the manifest:

> ### Tracker-aware commit messages
>
> When the session has linked tracker items and tracker automation is enabled, append closing-keyword lines to commit messages so each item closes automatically. Use the syntax matching the item's source:
> - **Native (****\`nimbalyst://\`****)** or **Linear (****\`linear://\`****)**: \`Fixes NIM-123\`
> - **GitHub same-repo**: \`Fixes #42\`
> - **GitHub cross-repo**: \`Fixes owner/repo#42\`
>
> One closing line per linked item. The user can edit them out in the commit widget before confirming.
`;

describe('Markdown round-trip corpus', () => {
  it('keeps isolated bold text containing inline code stable across double round-trip', () => {
    const markdown = '**Native (`nimbalyst://`)**';
    const {firstExport, secondExport} = doubleRoundTrip(markdown);

    expect(firstExport).toBe(markdown);
    expect(secondExport).toBe(firstExport);
  });

  it('keeps isolated italic text containing bold inline code stable across double round-trip', () => {
    const markdown = '*against the same **`TrackerProvider`** interface*';
    const {firstExport, secondExport} = doubleRoundTrip(markdown);

    expect(firstExport).toBe(markdown);
    expect(secondExport).toBe(firstExport);
  });

  it('round-trips the tracker strategy excerpt without escaped-emphasis drift', () => {
    const {firstExport, secondExport} = doubleRoundTrip(
      TRACKER_STRATEGY_PROBLEM_EXCERPT,
    );

    // Round-trip is now stable: re-importing the first export and re-exporting
    // produces identical bytes. CommonMark's emphasis rules still pair the
    // 4-star runs flanking ``nimbalyst://`` / ``linear://`` as bold + italic,
    // so the result includes a single `*` italic marker rather than the
    // pristine ``**Native (`nimbalyst://`)**`` form a human would type, but the
    // shape is now a fixed point under the importer.
    expect(secondExport).toBe(firstExport);
    expect(firstExport).not.toContain('****`nimbalyst://`****');
    expect(firstExport).not.toContain('****`linear://`****');
  });

  it('preserves frontmatter and checklist state across double round-trip', () => {
    const markdown = `---
planStatus:
  title: Lexical Upgrade
  progress: 25
---
# Lexical Upgrade

- [x] Add regression corpus
- [ ] Upgrade dependencies`;

    const {firstExport, secondExport} = doubleRoundTrip(markdown, {
      includeFrontmatter: true,
    });

    expect(firstExport).toBe(markdown);
    expect(secondExport).toBe(firstExport);
  });

  it('exports a single node as the node itself, not just its children', () => {
    const markdown = '# Upgrade Heading';
    const editor = createMarkdownEditor();
    let exported = '';

    importMarkdown(editor, markdown);
    editor.update(
      () => {
        const headingNode = $getRoot().getFirstChild();
        expect($isElementNode(headingNode)).toBe(true);

        exported = $convertNodeToEnhancedMarkdownString(
          MARKDOWN_TEST_TRANSFORMERS,
          headingNode as ElementNode,
          true,
        );
      },
      {discrete: true},
    );

    expect(exported).toBe(markdown);
  });

  it('exports a full-document selection with inline formatting preserved', () => {
    const markdown = 'Paragraph with **bold** and `code`.';
    const editor = createMarkdownEditor();
    let exported = '';

    importMarkdown(editor, markdown);
    editor.update(
      () => {
        $selectAll();
        const selection = $getSelection();
        exported = $convertSelectionToEnhancedMarkdownString(
          MARKDOWN_TEST_TRANSFORMERS,
          selection,
          true,
        );
      },
      {discrete: true},
    );

    expect(exported).toBe(markdown);
  });
});
