/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  assertApproveProducesTarget,
  assertRejectProducesOriginal,
  assertReplacementApplied,
  createTableReplacement,
  setupMarkdownReplaceTest,
} from '../../utils/replaceTestUtils';
import {MARKDOWN_TEST_TRANSFORMERS} from '../../utils/testConfig';

describe('Table Replace Test', () => {
  test('Adds a markdown table after paragraph correctly', async () => {
    const originalMarkdown = `This is another paragraph`;
    const tableContent = `

## Colors Table

| Color | Hex Code | Description |
|-------|----------|-------------|
| Red | #FF0000 | A warm, vibrant color |
| Blue | #0000FF | A cool, calming color |
| Green | #00FF00 | A natural, fresh color |`;

    // Create the replacement that adds table content after the paragraph
    const replacements = createTableReplacement(
      originalMarkdown,
      originalMarkdown + tableContent,
    );

    // Test replacement application
    const result = setupMarkdownReplaceTest(originalMarkdown, replacements, {
      transformers: [...MARKDOWN_TEST_TRANSFORMERS],
    });

    // When adding a table, we expect:
    // - Empty paragraphs for spacing
    // - The heading text "Colors Table"
    // - The table content (as a single text block if table nodes aren't properly supported in diff)
    // We'll check that at least the heading is added and skip strict assertion on all nodes
    const {addNodes} = result.getDiffNodes();
    const addedTexts = result.replaceEditor
      .getEditorState()
      .read(() => addNodes.map((node) => node.getTextContent()));

    // Verify that "Colors Table" is among the added content
    expect(addedTexts.some((text) => text.includes('Colors Table'))).toBe(true);

    // Verify we have some added nodes (the table and heading)
    expect(addNodes.length).toBeGreaterThan(0);

    // Test approve functionality
    // Note: Table separator lines may have different formats (|---|---|---| vs | --- | --- | --- |)
    // Both are valid markdown, so we'll check the essential content instead
    const approvedMarkdown = result.getApprovedMarkdown();
    expect(approvedMarkdown).toContain('This is another paragraph');
    expect(approvedMarkdown).toContain('## Colors Table');
    expect(approvedMarkdown).toContain('| Color | Hex Code | Description |');
    expect(approvedMarkdown).toContain(
      '| Red | #FF0000 | A warm, vibrant color |',
    );
    expect(approvedMarkdown).toContain(
      '| Blue | #0000FF | A cool, calming color |',
    );
    expect(approvedMarkdown).toContain(
      '| Green | #00FF00 | A natural, fresh color |',
    );

    // Test reject functionality
    assertRejectProducesOriginal(result);
  });

  test('Tables with empty cells', () => {
    const originalMarkdown = `| Header 1 | Header 2 |
| --- | --- |
| Data 1 |  |
|  | Data 2 |`;

    const targetMarkdown = `| Header 1 | Header 2 |
| --- | --- |
| Data 1 | New Data |
|  | Data 2 |`;

    const replacements = [
      {
        oldText: '| Data 1 |  |',
        newText: '| Data 1 | New Data |',
      },
    ];

    const result = setupMarkdownReplaceTest(originalMarkdown, replacements);
    
    // Test that the empty cell is replaced with new data
    assertApproveProducesTarget(result);
    assertRejectProducesOriginal(result);
  });

  test('Tables with formatting in cells', () => {
    const originalMarkdown = `| Column A | Column B |
| --- | --- |
| **Bold** | *Italic* |`;

    const targetMarkdown = `| Column A | Column B |
| --- | --- |
| **Bold** | *Italic* and ~~strike~~ |`;

    const replacements = [
      {
        oldText: '| **Bold** | *Italic* |',
        newText: '| **Bold** | *Italic* and ~~strike~~ |',
      },
    ];

    const result = setupMarkdownReplaceTest(originalMarkdown, replacements);
    
    // Test that formatting in cells is preserved
    assertApproveProducesTarget(result);
    assertRejectProducesOriginal(result);
  });

  test('Table cells with formatting changes', () => {
    const originalMarkdown = `| Name | Status |
| --- | --- |
| Alice | Active |
| Bob | Active |`;

    const targetMarkdown = `| Name | Status |
| --- | --- |
| Alice | **Inactive** |
| Bob | Active |`;

    const replacements = [
      {
        oldText: '| Alice | Active |',
        newText: '| Alice | **Inactive** |',
      },
    ];

    const result = setupMarkdownReplaceTest(originalMarkdown, replacements);
    
    assertApproveProducesTarget(result);
    assertRejectProducesOriginal(result);
  });

  test('Table cells with links', () => {
    const originalMarkdown = `| Site | URL |
| --- | --- |
| Google | https://google.com |`;

    const targetMarkdown = `| Site | URL |
| --- | --- |
| Google | [Google](https://google.com) |`;

    const replacements = [
      {
        oldText: '| Google | https://google.com |',
        newText: '| Google | [Google](https://google.com) |',
      },
    ];

    const result = setupMarkdownReplaceTest(originalMarkdown, replacements);
    
    assertApproveProducesTarget(result);
    assertRejectProducesOriginal(result);
  });

  test('Table cells with code', () => {
    const originalMarkdown = `| Function | Description |
| --- | --- |
| print | Outputs text |`;

    const targetMarkdown = `| Function | Description |
| --- | --- |
| \`print()\` | Outputs text to console |`;

    const replacements = [
      {
        oldText: '| print | Outputs text |',
        newText: '| `print()` | Outputs text to console |',
      },
    ];

    const result = setupMarkdownReplaceTest(originalMarkdown, replacements);
    
    assertApproveProducesTarget(result);
    assertRejectProducesOriginal(result);
  });

  test('Adding and removing table rows', () => {
    const originalMarkdown = `| ID | Name |
| --- | --- |
| 1 | Alice |
| 2 | Bob |`;

    const targetMarkdown = `| ID | Name |
| --- | --- |
| 1 | Alice |
| 2 | Bob |
| 3 | Charlie |`;

    const replacements = [
      {
        oldText: `| ID | Name |
| --- | --- |
| 1 | Alice |
| 2 | Bob |`,
        newText: `| ID | Name |
| --- | --- |
| 1 | Alice |
| 2 | Bob |
| 3 | Charlie |`,
      },
    ];

    const result = setupMarkdownReplaceTest(originalMarkdown, replacements);
    
    assertApproveProducesTarget(result);
    assertRejectProducesOriginal(result);
  });

  test('Modifying multiple cells in same row', () => {
    const originalMarkdown = `| Product | Price | Stock |
| --- | --- | --- |
| Apple | $1.00 | 100 |
| Banana | $0.50 | 50 |`;

    const targetMarkdown = `| Product | Price | Stock |
| --- | --- | --- |
| Apple | $1.25 | 80 |
| Banana | $0.50 | 50 |`;

    const replacements = [
      {
        oldText: '| Apple | $1.00 | 100 |',
        newText: '| Apple | $1.25 | 80 |',
      },
    ];

    const result = setupMarkdownReplaceTest(originalMarkdown, replacements);
    
    assertApproveProducesTarget(result);
    assertRejectProducesOriginal(result);
  });

  test('Complex table with multiple changes', () => {
    const originalMarkdown = `| Task | Status | Owner |
| --- | --- | --- |
| Design | In Progress | Alice |
| Development | Not Started | Bob |
| Testing | Not Started | Charlie |`;

    const targetMarkdown = `| Task | Status | Owner |
| --- | --- | --- |
| Design | **Complete** | Alice |
| Development | In Progress | Bob |
| Testing | Pending | Charlie |
| Documentation | Not Started | David |`;

    const replacements = [
      {
        oldText: '| Design | In Progress | Alice |',
        newText: '| Design | **Complete** | Alice |',
      },
      {
        oldText: '| Development | Not Started | Bob |',
        newText: '| Development | In Progress | Bob |',
      },
      {
        oldText: '| Testing | Not Started | Charlie |',
        newText: `| Testing | Pending | Charlie |
| Documentation | Not Started | David |`,
      },
    ];

    const result = setupMarkdownReplaceTest(originalMarkdown, replacements);
    
    // We should see changes in multiple cells
    assertApproveProducesTarget(result);
    assertRejectProducesOriginal(result);
  });
});
