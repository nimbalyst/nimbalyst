

/**
 * Basic test to verify that all imports work correctly.
 * This serves as a sanity check before running complex tests.
 */

console.log('Testing basic imports...');

try {
  // Test testConfig imports
  const testConfig = require('./testConfig');
  console.log('✅ testConfig imports successful');

  // Test if we can create a test editor
  const editor = testConfig.createTestEditor();
  console.log('✅ createTestEditor works');

  // Test diffTestUtils imports
  const diffTestUtils = require('./diffTestUtils');
  console.log('✅ diffTestUtils imports successful');

  // Test replaceTestUtils imports
  const replaceTestUtils = require('./replaceTestUtils');
  console.log('✅ replaceTestUtils imports successful');

  console.log('🎉 All basic imports work correctly!');

} catch (error) {
  console.error('❌ Import test failed:', error instanceof Error ? error.message : String(error));
  console.error('Full error:', error);
  process.exit(1);
}
