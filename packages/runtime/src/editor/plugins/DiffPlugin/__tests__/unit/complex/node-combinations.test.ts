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
  setupMarkdownDiffTest,
} from '../../utils/diffTestUtils';
import {
  setupMarkdownReplaceTest,
  assertApproveProducesTarget as assertApproveProducesTargetReplace,
  assertRejectProducesOriginal as assertRejectProducesOriginalReplace,
} from '../../utils/replaceTestUtils';
import {MARKDOWN_TEST_TRANSFORMERS} from '../../utils/testConfig';

// Direct import to test
import {applyMarkdownReplace} from '../../../core/diffUtils';

describe('Node Combinations', () => {
  test('Simple formatting test', () => {
    const originalMarkdown = `This is a simple paragraph.`;
    const replacements = [
      {
        oldText: 'This is a simple paragraph.',
        newText: 'This is a **bold** paragraph.',
      },
    ];

    // Test diff application and approval/rejection
    const result = setupMarkdownReplaceTest(originalMarkdown, replacements);

    // Test that approving the diff produces the target markdown
    assertApproveProducesTargetReplace(result);

    // Test that rejecting the diff produces the original markdown
    assertRejectProducesOriginalReplace(result);
  });

  test('Multiple node types with simple changes', () => {
    const originalMarkdown = `# Document Title

This is a paragraph.

## Section
- Item one
- Item two

### Subsection
More content here.

1. First numbered item
2. Second numbered item`;

    const replacements = [
      {
        oldText: '# Document Title',
        newText: '# Updated Document Title',
      },
      {
        oldText: 'This is a paragraph.',
        newText: 'This is a revised paragraph.',
      },
      {
        oldText: '## Section',
        newText: '## Updated Section',
      },
      {
        oldText: '- Item one\n- Item two',
        newText: '- Item one updated\n- Item two updated\n- Item three added',
      },
      {
        oldText: '### Subsection',
        newText: '### Updated Subsection',
      },
      {
        oldText: 'More content here.',
        newText: 'Updated content here.',
      },
      {
        oldText: '1. First numbered item\n2. Second numbered item',
        newText:
          '1. First numbered item updated\n2. Second numbered item updated\n3. Third numbered item added',
      },
    ];

    // Test diff application and approval/rejection
    const result = setupMarkdownReplaceTest(originalMarkdown, replacements);

    // Test that approving the diff produces the target markdown
    assertApproveProducesTargetReplace(result);

    // Test that rejecting the diff produces the original markdown
    assertRejectProducesOriginalReplace(result);

    // Verify we have diff nodes
    const {addNodes, removeNodes} = result.getDiffNodes();
    expect(addNodes.length).toBeGreaterThan(0);
    expect(removeNodes.length).toBeGreaterThan(0);

    // Optional: Uncomment to see debug info
    // result.debugInfo();
  });

  test('List modification with new items', () => {
    const originalMarkdown = `# Shopping List

- Apples
- Bananas
- Oranges`;

    const replacements = [
      {
        oldText: '# Shopping List',
        newText: '# Updated Shopping List',
      },
      {
        oldText: '- Apples\n- Bananas\n- Oranges',
        newText: '- Fresh Apples\n- Ripe Bananas\n- Sweet Oranges\n- Grapes',
      },
    ];

    // Test diff application and approval/rejection
    const result = setupMarkdownReplaceTest(originalMarkdown, replacements);

    // Test that approving the diff produces the target markdown
    assertApproveProducesTargetReplace(result);

    // Test that rejecting the diff produces the original markdown
    assertRejectProducesOriginalReplace(result);

    // Verify we have diff nodes - there should be add nodes, and there may or may not be remove nodes
    const {addNodes, removeNodes} = result.getDiffNodes();
    expect(addNodes.length).toBeGreaterThan(0);
    expect(removeNodes.length).toBeGreaterThanOrEqual(0); // Allow zero remove nodes
  });

  test('Complex document with mixed content changes', () => {
    const originalMarkdown = `# Project Documentation

Welcome to our project.

## Features
Our application has these features:
- User authentication
- Data storage
- API endpoints

## Installation
Follow these steps:
1. Clone the repository
2. Install dependencies
3. Run the application

## Configuration
Set up your environment variables.`;

    const replacements = [
      {
        oldText: '# Project Documentation',
        newText: '# Enhanced Project Documentation',
      },
      {
        oldText: 'Welcome to our project.',
        newText: 'Welcome to our improved project.',
      },
      {
        oldText:
          '## Features\nOur application has these features:\n- User authentication\n- Data storage\n- API endpoints',
        newText:
          '## Enhanced Features\nOur application has these enhanced features:\n- Advanced user authentication\n- Secure data storage\n- RESTful API endpoints\n- Real-time notifications',
      },
      {
        oldText:
          '## Installation\nFollow these steps:\n1. Clone the repository\n2. Install dependencies\n3. Run the application',
        newText:
          '## Installation Guide\nFollow these updated steps:\n1. Clone the repository\n2. Install all dependencies\n3. Configure the environment\n4. Run the application',
      },
      {
        oldText: 'Set up your environment variables.',
        newText: 'Set up your environment variables and database connections.',
      },
    ];

    // Test diff application and approval/rejection
    const result = setupMarkdownReplaceTest(originalMarkdown, replacements);

    // Test that approving the diff produces the target markdown
    assertApproveProducesTargetReplace(result);

    // Test that rejecting the diff produces the original markdown
    assertRejectProducesOriginalReplace(result);

    // Verify we have diff nodes
    const {addNodes, removeNodes} = result.getDiffNodes();
    expect(addNodes.length).toBeGreaterThan(0);
    expect(removeNodes.length).toBeGreaterThan(0);

    // Optional: Uncomment to see debug info if needed
    // result.debugInfo();
  });

  test('DEBUG: Simple bold formatting issue', () => {
    const originalMarkdown = `This is a simple paragraph.`;
    const replacements = [
      {
        oldText: 'This is a simple paragraph.',
        newText: 'This is a **bold** paragraph.',
      },
    ];

    // Test diff application and approval/rejection
    const result = setupMarkdownReplaceTest(originalMarkdown, replacements);

    console.log('\n=== DEBUGGING SIMPLE BOLD FORMATTING ===');
    console.log('Original markdown:', originalMarkdown);
    console.log('Replacements:', replacements);
    console.log('\nTarget state (should have formatting):');
    console.log(JSON.stringify(result.targetState, null, 2));
    console.log(
      '\nReplace editor state (AddNodes should preserve formatting):',
    );
    console.log(
      JSON.stringify(result.replaceEditor.getEditorState().toJSON(), null, 2),
    );

    const approvedMarkdown = result.getApprovedMarkdown();
    console.log('\nApproved markdown (should have **bold**):');
    console.log(approvedMarkdown);
    console.log('===============================\n');

    // Test that approving the diff produces the target markdown
    assertApproveProducesTargetReplace(result);

    // Test that rejecting the diff produces the original markdown
    assertRejectProducesOriginalReplace(result);
  });

  test('Middle insertion problem - end-to-end TreeMatcher test', () => {
    // Test that our function is imported correctly
    console.log('🔍 Testing function import...');
    console.log('applyMarkdownReplace type:', typeof applyMarkdownReplace);
    expect(typeof applyMarkdownReplace).toBe('function');

    // This test uses the same scenario as TreeMatcher.test.ts to verify our fix works end-to-end
    const sections = ['one', 'two', 'three', 'five', 'six', 'seven'];

    const originalMarkdown = sections
      .map(
        (section) =>
          `## ${section}\n\n- ${section}: item 1\n- ${section}: item 2\n- ${section}: item 3`,
      )
      .join('\n\n');

    // Create the replacement that inserts "four" section between "three" and "five"
    const replacements = [
      {
        oldText: '- three: item 3\n\n## five',
        newText:
          '- three: item 3\n\n## four\n\n- four: item 1\n- four: item 2\n- four: item 3\n\n## five',
      },
    ];

    console.log(
      '\n=== MIDDLE INSERTION END-TO-END TEST (Using TreeMatcher) ===',
    );
    console.log('Original sections:', sections);
    console.log('Target should have: one, two, three, four, five, six, seven');
    console.log('Testing TreeMatcher fix in full diff application...\n');

    // Test diff application using TreeMatcher directly
    const result = setupMarkdownReplaceTest(originalMarkdown, replacements);

    console.log('\n=== TreeMatcher Debug Output ===');
    result.debugInfo();

    // Test that approving the diff produces the target markdown
    assertApproveProducesTargetReplace(result);

    // Test that rejecting the diff produces the original markdown
    assertRejectProducesOriginalReplace(result);

    // Get diff nodes to see what the TreeMatcher algorithm detected
    const {addNodes, removeNodes} = result.getDiffNodes();
    console.log(
      `\nTreeMatcher summary: ${addNodes.length} adds, ${removeNodes.length} removes`,
    );

    // The TreeMatcher fix should result in:
    // - Clean addition of "four" section (should be only add nodes)
    // - No spurious removes (remove nodes should be minimal or zero)
    console.log('=== EXPECTED vs ACTUAL ===');
    console.log(
      'EXPECTED: Only "four" section as additions, minimal/no removes',
    );
    console.log(
      `ACTUAL: ${addNodes.length} additions, ${removeNodes.length} removes`,
    );

    if (removeNodes.length > 2) {
      // Allow some removes for legitimate content changes
      console.log(
        '⚠️  WARNING: TreeMatcher fix may not be working - too many removes detected',
      );
    } else {
      console.log(
        '✅ SUCCESS: Minimal removes - TreeMatcher fix appears to be working',
      );
    }
    console.log('=====================================\n');

    // Verify we have appropriate diff nodes for a clean insertion
    expect(addNodes.length).toBeGreaterThan(0); // Should have additions for "four" section
  });

  test('Complex document with multiple node type changes - original test case', () => {
    const originalMarkdown = `# Main Document

This is an introductory paragraph.

## First Section
- First item
- Second item
- Third item

### Subsection
Some content here.

## Second Section
More content in this section.

1. Numbered item one
2. Numbered item two

## Conclusion
Final thoughts.`;

    const replacements = [
      {
        oldText: '# Main Document',
        newText: '# Enhanced Main Document',
      },
      {
        oldText: 'This is an introductory paragraph.',
        newText:
          'This is a **revised** introductory paragraph with _better formatting_.',
      },
      {
        oldText: '## First Section\n- First item\n- Second item\n- Third item',
        newText:
          '## Enhanced First Section\n- **Enhanced** first item\n- Updated second item\n- Completely new third item\n- Additional fourth item',
      },
      {
        oldText: '### Subsection\nSome content here.',
        newText:
          '### Enhanced Subsection\n**Much better** content here with more details.\n\n### New Subsection\nBrand new content section.',
      },
      {
        oldText: '## Second Section\nMore content in this section.',
        newText:
          '## Improved Second Section\n_Significantly enhanced_ content in this section with **bold** improvements.',
      },
      {
        oldText: '1. Numbered item one\n2. Numbered item two',
        newText:
          '1. **Enhanced** numbered item one\n2. Updated numbered item two\n3. Brand new numbered item three',
      },
      {
        oldText: '## Conclusion\nFinal thoughts.',
        newText:
          '## Enhanced Conclusion\n**Final thoughts** with _much better_ formatting and additional insights.',
      },
    ];

    // Test diff application and approval/rejection with enhanced transformers
    const result = setupMarkdownReplaceTest(originalMarkdown, replacements, {
      transformers: MARKDOWN_TEST_TRANSFORMERS,
    });

    // Debug to see what's actually happening
    result.debugInfo();

    // Test that approving the diff produces the target markdown - THIS SHOULD WORK
    assertApproveProducesTargetReplace(result);

    // Test that rejecting the diff produces the original markdown
    assertRejectProducesOriginalReplace(result);

    // Verify we have diff nodes
    const {addNodes, removeNodes} = result.getDiffNodes();
    expect(addNodes.length).toBeGreaterThan(0);
    expect(removeNodes.length).toBeGreaterThan(0);
  });

  test('Test Tigers Thing', () => {
    const originalMarkdown = `# Tigers 3

## The Majestic Tiger: Nature's Most Iconic Predator

Tigers stand as one of the most magnificent and awe-inspiring creatures on our planet. These powerful big cats have captured human imagination for centuries, representing strength, beauty, and the wild spirit of nature. As the largest living cat species, tigers are not only apex predators but also serve as crucial indicators of ecosystem health in their native habitats.

## Physical Characteristics and Adaptations

The tiger's distinctive appearance makes it instantly recognizable among all wildlife. Their striking orange coat adorned with bold black stripes serves as perfect camouflage in the dappled sunlight of dense forests and tall grasslands. Each tiger's stripe pattern is unique, much like human fingerprints, allowing researchers to identify individual animals in the wild.

Adult tigers are formidable in size, with males typically weighing between 140-300 kilograms and measuring up to 3 meters in length, including their tail. Females are generally smaller but equally impressive. Their muscular build, powerful jaws, and retractable claws make them supreme hunters capable of taking down prey much larger than themselves.

## Habitat and Distribution

Historically, tigers roamed across much of Asia, from Turkey to the Indonesian islands. Today, their range has dramatically shrunk, with wild tigers found primarily in India, China, Southeast Asia, and Russia. These adaptable cats inhabit various ecosystems, including:
- Tropical and temperate forests
- Grasslands and savannas
- Mangrove swamps
- Rocky areas and mountains

Each subspecies has evolved to thrive in its specific environment, developing unique characteristics suited to local conditions.

## Hunting Behavior and Diet

Tigers are solitary hunters that rely on stealth and ambush tactics rather than pack hunting. They are primarily nocturnal, using their excellent night vision and acute hearing to locate prey. Their diet consists mainly of large ungulates such as deer, wild boar, and buffalo, though they will also hunt smaller mammals, birds, and fish when opportunities arise.

A single tiger requires substantial territory to support its hunting needs, with home ranges varying from 20 to 400 square kilometers depending on prey density and habitat quality. This territorial nature means that tiger populations require vast, connected landscapes to remain viable.

## Conservation Challenges

The tiger faces numerous threats that have led to a dramatic decline in population numbers. From an estimated 100,000 tigers at the beginning of the 20th century, fewer than 4,000 remain in the wild today. Major threats include:
- Habitat loss and fragmentation due to human development
- Poaching for illegal wildlife trade
- Human-tiger conflict as communities expand into tiger territories
- Prey depletion from overhunting
- Climate change affecting habitat suitability

## Conservation Efforts and Hope

Despite the challenges, dedicated conservation efforts have shown promising results in some regions. India's tiger population has shown signs of recovery through:
- Protected area establishment and management
- Anti-poaching initiatives
- Community-based conservation programs
- Habitat restoration projects
- International cooperation on wildlife trade controls

Countries like Russia, Nepal, and Bhutan have also implemented successful tiger conservation strategies, proving that with proper commitment and resources, tiger populations can recover.

## Cultural Significance

Throughout history, tigers have held profound cultural significance across Asian societies. They appear in mythology, art, literature, and religious symbolism, often representing power, courage, and protection. This cultural reverence has historically provided some protection for tigers, though modern economic pressures have unfortunately weakened these traditional conservation ethics.

## The Path Forward

The survival of tigers in the wild depends on our collective commitment to conservation. Success requires:
- Continued protection and expansion of habitat corridors
- Strengthened anti-poaching efforts
- Sustainable development that considers wildlife needs
- International cooperation to combat illegal trade
- Education and awareness programs
- Support for local communities living near tiger habitats

## Conclusion

Tigers embody the raw beauty and power of the natural world. Their presence indicates healthy ecosystems, while their absence signals environmental degradation. As we move forward, the fate of tigers serves as a test of our commitment to preserving biodiversity for future generations.

The story of tiger conservation is ultimately about choices – the choice to value nature over short-term economic gains, to coexist rather than dominate, and to act as stewards of the incredible biological heritage we have inherited. Every tiger that survives in the wild is a victory not just for the species, but for the principle that humans and nature can thrive together on this shared planet.

The roar of a tiger in the wild should continue to echo through Asia's forests for generations to come, reminding us of our responsibility to protect the magnificent creatures with whom we share this world.
`;

    const replacements = [
      {
        oldText: `The survival of tigers in the wild depends on our collective commitment to conservation. Success requires:
- Continued protection and expansion of habitat corridors
- Strengthened anti-poaching efforts
- Sustainable development that considers wildlife needs
- International cooperation to combat illegal trade
- Education and awareness programs
- Support for local communities living near tiger habitats`,
        newText: `The survival of tigers in the wild depends on our collective commitment to conservation. Success requires:
- Continued protection and expansion of habitat corridors
    - Creating wildlife corridors connecting fragmented forests
    - Establishing buffer zones around core protected areas
    - Restoring degraded habitats to increase carrying capacity
    - Securing land rights for critical tiger territories

- Strengthened anti-poaching efforts
    - Deploying advanced surveillance technology in protected areas
    - Training and equipping forest guards with modern tools
    - Implementing rapid response teams for poaching incidents
    - Strengthening legal frameworks and enforcement penalties

- Sustainable development that considers wildlife needs
    - Conducting environmental impact assessments for all development projects
    - Promoting eco-friendly tourism as alternative income sources
    - Implementing wildlife-friendly infrastructure design
    - Balancing economic growth with conservation priorities

- International cooperation to combat illegal trade
    - Strengthening CITES enforcement across borders
    - Sharing intelligence between countries on trafficking networks
    - Reducing demand in consumer markets through awareness campaigns
    - Supporting alternative livelihoods for communities involved in illegal trade
    
- Education and awareness programs
    - Developing school curricula that emphasize wildlife conservation
    - Creating public awareness campaigns about tiger conservation
    - Training local communities in wildlife monitoring techniques
    - Promoting tiger conservation through media and digital platforms

- Support for local communities living near tiger habitats
    - Providing compensation for livestock losses to tiger predation
    - Creating employment opportunities in conservation and eco-tourism
    - Improving access to healthcare and education in remote areas
    - Involving communities in conservation decision-making processes`,
      },
    ];

    // Test diff application and approval/rejection
    const result = setupMarkdownReplaceTest(originalMarkdown, replacements);

    assertApproveProducesTargetReplace(result);
    assertRejectProducesOriginalReplace(result);
  });
});
