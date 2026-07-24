import {
  setupMarkdownDiffTest,
  assertApproveProducesTarget,
} from '../../utils/diffTestUtils';

describe('AI Table Row Addition Issues', () => {
  test('AI suggesting complete table replacement instead of row addition', () => {
    // This simulates what happens when AI suggests adding rows
    // but generates a complete table replacement
    const originalMarkdown = `# Tables

| Fruit | Vitamins | Description |
| --- | --- | --- |
| Kiwi | C, K, E | Green, fuzzy exterior with sweet-tart flesh |
| Mango | A, C, E | Tropical stone fruit with creamy, sweet flesh |`;

    // AI tends to generate the entire table again with new rows
    // This is what causes the duplication issue
    const aiSuggestedMarkdown = `# Tables

| Fruit | Vitamins | Description |
| --- | --- | --- |
| Kiwi | C, K, E | Green, fuzzy exterior with sweet-tart flesh |
| Mango | A, C, E | Tropical stone fruit with creamy, sweet flesh |
| Apple | C, K | Crisp fruit available in many varieties |
| Orange | C, Folate | Citrus fruit high in vitamin C |
| Banana | B6, C | Yellow fruit rich in potassium |`;

    const result = setupMarkdownDiffTest(originalMarkdown, aiSuggestedMarkdown);
    
    // Check what's happening
    const {addNodes, removeNodes} = result.getDiffNodes();
    
    // The table should be modified, NOT have a duplicate added
    const addedTables = addNodes.filter(node => node.getType() === 'table');
    const removedTables = removeNodes.filter(node => node.getType() === 'table');
    
    console.log('Added tables:', addedTables.length);
    console.log('Removed tables:', removedTables.length);
    
    // This should be 0 - we don't want duplicate tables
    expect(addedTables.length).toBe(0);
    expect(removedTables.length).toBe(0);
    
    // Check that rows are properly added
    const addedRows = addNodes.filter(node => node.getType() === 'tablerow');
    expect(addedRows.length).toBe(3); // Three new fruit rows
    
    // Verify the final markdown doesn't have duplicate tables
    const approvedMarkdown = result.getApprovedMarkdown();
    const tableMatches = approvedMarkdown.match(/\| Fruit \| Vitamins/g) || [];
    expect(tableMatches.length).toBe(1); // Should only have one table
    
    // Verify all rows are present
    expect(approvedMarkdown).toContain('| Kiwi |');
    expect(approvedMarkdown).toContain('| Mango |');
    expect(approvedMarkdown).toContain('| Apple |');
    expect(approvedMarkdown).toContain('| Orange |');
    expect(approvedMarkdown).toContain('| Banana |');
    
    assertApproveProducesTarget(result);
  });

  test('AI suggesting rows as separate content block', () => {
    // Sometimes AI generates just the new rows as a separate block
    // This also causes issues
    const originalMarkdown = `# Tables

| Letter | Greek | Phonetic |
| --- | --- | --- |
| A | Alpha | Alpha |
| B | Beta | Bravo |`;

    // AI might suggest adding rows like this (as a separate table fragment)
    const aiSuggestedAddition = `| C | Gamma | Charlie |
| D | Delta | Delta |
| E | Epsilon | Echo |`;

    // This would need special handling to merge into the existing table
    // For now, we'll test the expected combined result
    const targetMarkdown = `# Tables

| Letter | Greek | Phonetic |
| --- | --- | --- |
| A | Alpha | Alpha |
| B | Beta | Bravo |
| C | Gamma | Charlie |
| D | Delta | Delta |
| E | Epsilon | Echo |`;

    const result = setupMarkdownDiffTest(originalMarkdown, targetMarkdown);
    
    const {addNodes} = result.getDiffNodes();
    
    // Check that rows are added to the existing table
    const addedRows = addNodes.filter(node => node.getType() === 'tablerow');
    expect(addedRows.length).toBe(3);
    
    // No duplicate tables
    const approvedMarkdown = result.getApprovedMarkdown();
    const tableMatches = approvedMarkdown.match(/\| Letter \| Greek/g) || [];
    expect(tableMatches.length).toBe(1);
    
    assertApproveProducesTarget(result);
  });

  test('Multiple AI suggestions creating multiple duplicate tables', () => {
    // This simulates the screenshot scenario where multiple AI suggestions
    // each create their own table
    const originalMarkdown = `# Tables

| Task | Status |
| --- | --- |
| Design | Complete |`;

    // First AI suggestion: "add three rows"
    const firstSuggestion = `# Tables

| Task | Status |
| --- | --- |
| Design | Complete |
| Development | In Progress |
| Testing | Not Started |
| Documentation | Not Started |`;

    // Second AI suggestion: "add 2 rows" 
    const secondSuggestion = `# Tables

| Task | Status |
| --- | --- |
| Design | Complete |
| Development | In Progress |
| Testing | Not Started |
| Documentation | Not Started |
| Deployment | Not Started |
| Review | Not Started |`;

    // Test applying first suggestion
    const result1 = setupMarkdownDiffTest(originalMarkdown, firstSuggestion);
    
    const {addNodes: addNodes1} = result1.getDiffNodes();
    const addedTables1 = addNodes1.filter(node => node.getType() === 'table');
    
    // Should not create a duplicate table
    expect(addedTables1.length).toBe(0);
    
    // Then test applying second suggestion on top
    const result2 = setupMarkdownDiffTest(firstSuggestion, secondSuggestion);
    
    const {addNodes: addNodes2} = result2.getDiffNodes();
    const addedTables2 = addNodes2.filter(node => node.getType() === 'table');
    
    // Should still not create a duplicate table
    expect(addedTables2.length).toBe(0);
    
    assertApproveProducesTarget(result1);
    assertApproveProducesTarget(result2);
  });
});