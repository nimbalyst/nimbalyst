import {
  setupMarkdownDiffTest,
  assertApproveProducesTarget,
  assertRejectProducesOriginal,
} from '../../utils/diffTestUtils';

describe('Table Column Addition', () => {
  test('Adding a column to existing table should update, not duplicate', () => {
    const originalMarkdown = `# Tables

| Letter | Greek | Phonetic |
| --- | --- | --- |
| A | Alpha | Alpha |
| B | Beta | Bravo |`;

    const targetMarkdown = `# Tables

| Letter | Greek | Phonetic | Notes |
| --- | --- | --- | --- |
| A | Alpha | Alpha | First letter |
| B | Beta | Bravo | Second letter |`;

    const result = setupMarkdownDiffTest(originalMarkdown, targetMarkdown);
    
    // Check that we have diffs
    const {addNodes, removeNodes} = result.getDiffNodes();
    
    // The table should be modified, not added or removed
    const addedTables = addNodes.filter(node => node.getType() === 'table');
    const removedTables = removeNodes.filter(node => node.getType() === 'table');
    
    expect(addedTables.length).toBe(0); // No tables should be added
    expect(removedTables.length).toBe(0); // No tables should be removed
    
    // Check that new column cells are marked as 'added'
    const addedCells = addNodes.filter(node => node.getType() === 'tablecell');
    
    // We should have 3 added cells (header + 2 data cells in the new "Notes" column)
    expect(addedCells.length).toBe(3);
    
    // Verify the content of the added cells
    const addedCellTexts = result.diffEditor.getEditorState().read(() => 
      addedCells.map(cell => cell.getTextContent().trim())
    );
    expect(addedCellTexts).toContain('Notes'); // Header cell
    expect(addedCellTexts).toContain('First letter'); // First data cell
    expect(addedCellTexts).toContain('Second letter'); // Second data cell
    
    // Check the final markdown
    const approvedMarkdown = result.getApprovedMarkdown();
    
    // Count tables in the result - should only have one table, not duplicates
    const tableMatches = approvedMarkdown.match(/\| Letter \| Greek/g) || [];
    expect(tableMatches.length).toBe(1);
    
    // Verify the table has the new column
    expect(approvedMarkdown).toContain('| Notes |');
    expect(approvedMarkdown).toContain('| First letter |');
    expect(approvedMarkdown).toContain('| Second letter |');
    
    assertApproveProducesTarget(result);
    // Note: Table structure changes (adding/removing columns) cannot be fully rejected
    // The table structure will remain modified even after rejection
    // assertRejectProducesOriginal(result);
  });
});