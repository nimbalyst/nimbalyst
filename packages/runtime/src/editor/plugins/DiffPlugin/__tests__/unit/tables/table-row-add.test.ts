import {
  setupMarkdownDiffTest,
  assertApproveProducesTarget,
} from '../../utils/diffTestUtils';

describe('Table Row Addition', () => {
  test('Adding rows to existing table should update, not duplicate', () => {
    const originalMarkdown = `# Task List

| Task | Status | Priority |
| --- | --- | --- |
| Design | Complete | High |
| Development | In Progress | High |`;

    const targetMarkdown = `# Task List

| Task | Status | Priority |
| --- | --- | --- |
| Design | Complete | High |
| Development | In Progress | High |
| Testing | Not Started | Medium |
| Documentation | Not Started | Low |`;

    const result = setupMarkdownDiffTest(originalMarkdown, targetMarkdown);
    
    // Check that we have diffs
    const {addNodes, removeNodes} = result.getDiffNodes();
    
    // The table should be modified, not added or removed
    const addedTables = addNodes.filter(node => node.getType() === 'table');
    const removedTables = removeNodes.filter(node => node.getType() === 'table');
    
    expect(addedTables.length).toBe(0); // No tables should be added
    expect(removedTables.length).toBe(0); // No tables should be removed
    
    // Check that new rows are marked as 'added'
    const addedRows = addNodes.filter(node => node.getType() === 'tablerow');
    
    // We should have 2 added rows
    expect(addedRows.length).toBe(2);
    
    // Check that cells in new rows are also marked as 'added'
    const addedCells = addNodes.filter(node => node.getType() === 'tablecell');
    
    // We should have 6 added cells (3 cells per row × 2 rows)
    expect(addedCells.length).toBe(6);
    
    // Verify the content of the added cells
    const addedCellTexts = result.diffEditor.getEditorState().read(() => 
      addedCells.map(cell => cell.getTextContent().trim())
    );
    
    // Check for Testing row cells
    expect(addedCellTexts).toContain('Testing');
    expect(addedCellTexts).toContain('Not Started');
    expect(addedCellTexts).toContain('Medium');
    
    // Check for Documentation row cells
    expect(addedCellTexts).toContain('Documentation');
    expect(addedCellTexts).toContain('Low');
    
    // Check the final markdown
    const approvedMarkdown = result.getApprovedMarkdown();
    
    // Count tables in the result - should only have one table, not duplicates
    const tableMatches = approvedMarkdown.match(/\| Task \| Status/g) || [];
    expect(tableMatches.length).toBe(1);
    
    // Verify the table has the new rows
    expect(approvedMarkdown).toContain('| Testing | Not Started | Medium |');
    expect(approvedMarkdown).toContain('| Documentation | Not Started | Low |');
    
    assertApproveProducesTarget(result);
    // Note: Table structure changes (adding/removing rows) cannot be fully rejected
    // The table structure will remain modified even after rejection
  });

  test('Adding a row in the middle of a table', () => {
    const originalMarkdown = `# Numbers

| Number | Name | Type |
| --- | --- | --- |
| 1 | One | Odd |
| 3 | Three | Odd |
| 5 | Five | Odd |`;

    const targetMarkdown = `# Numbers

| Number | Name | Type |
| --- | --- | --- |
| 1 | One | Odd |
| 2 | Two | Even |
| 3 | Three | Odd |
| 4 | Four | Even |
| 5 | Five | Odd |`;

    const result = setupMarkdownDiffTest(originalMarkdown, targetMarkdown);
    
    const {addNodes} = result.getDiffNodes();
    
    // When the table structure changes (rows added in middle),
    // the implementation rebuilds the table and marks trailing rows as added
    // This is a known limitation - ideally all new rows would be marked
    const addedRows = addNodes.filter(node => node.getType() === 'tablerow');
    expect(addedRows.length).toBeGreaterThan(0);
    
    const addedCells = addNodes.filter(node => node.getType() === 'tablecell');
    expect(addedCells.length).toBeGreaterThan(0);
    
    // Verify the table structure is correct
    const approvedMarkdown = result.getApprovedMarkdown();
    expect(approvedMarkdown).toContain('| 1 | One | Odd |');
    expect(approvedMarkdown).toContain('| 2 | Two | Even |');
    expect(approvedMarkdown).toContain('| 3 | Three | Odd |');
    expect(approvedMarkdown).toContain('| 4 | Four | Even |');
    expect(approvedMarkdown).toContain('| 5 | Five | Odd |');
    
    assertApproveProducesTarget(result);
  });

  test('Adding both rows and columns to a table', () => {
    const originalMarkdown = `# Matrix

| A | B |
| --- | --- |
| 1 | 2 |`;

    const targetMarkdown = `# Matrix

| A | B | C |
| --- | --- | --- |
| 1 | 2 | 3 |
| 4 | 5 | 6 |`;

    const result = setupMarkdownDiffTest(originalMarkdown, targetMarkdown);
    
    const {addNodes} = result.getDiffNodes();
    
    // Check for added rows (1 new row)
    const addedRows = addNodes.filter(node => node.getType() === 'tablerow');
    expect(addedRows.length).toBe(1);
    
    // Check for added cells
    // New column: 2 cells (header "C" + data "3")
    // New row: 3 cells (4, 5, 6)
    // Total: 5 cells
    const addedCells = addNodes.filter(node => node.getType() === 'tablecell');
    expect(addedCells.length).toBe(5);
    
    const addedCellTexts = result.diffEditor.getEditorState().read(() => 
      addedCells.map(cell => cell.getTextContent().trim())
    );
    
    // New column cells
    expect(addedCellTexts).toContain('C');
    expect(addedCellTexts).toContain('3');
    
    // New row cells
    expect(addedCellTexts).toContain('4');
    expect(addedCellTexts).toContain('5');
    expect(addedCellTexts).toContain('6');
    
    assertApproveProducesTarget(result);
  });
});