#!/usr/bin/env npx tsx

import * as fs from 'fs';
import * as path from 'path';

const LOREM_PARAGRAPHS = [
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.',
  'Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.',
  'Sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium doloremque laudantium, totam rem aperiam, eaque ipsa quae ab illo inventore veritatis et quasi architecto beatae vitae dicta sunt explicabo.',
  'Nemo enim ipsam voluptatem quia voluptas sit aspernatur aut odit aut fugit, sed quia consequuntur magni dolores eos qui ratione voluptatem sequi nesciunt.',
  'Neque porro quisquam est, qui dolorem ipsum quia dolor sit amet, consectetur, adipisci velit, sed quia non numquam eius modi tempora incidunt ut labore et dolore magnam aliquam quaerat voluptatem.',
];

function generateMarkdown(targetBytes: number): string {
  const lines: string[] = ['# Large Test Document\n'];
  let currentSize = lines[0].length;
  let paragraphIndex = 0;
  let sectionNumber = 1;

  while (currentSize < targetBytes) {
    // Add a heading every 5 paragraphs
    if (paragraphIndex % 5 === 0) {
      const heading = `\n## Section ${sectionNumber}\n\n`;
      lines.push(heading);
      currentSize += heading.length;
      sectionNumber++;
    }

    const paragraph = LOREM_PARAGRAPHS[paragraphIndex % LOREM_PARAGRAPHS.length] + '\n\n';
    lines.push(paragraph);
    currentSize += paragraph.length;
    paragraphIndex++;
  }

  return lines.join('');
}

function main() {
  const args = process.argv.slice(2);

  // Default to 100KB
  let targetKB = 100;
  let outputPath = 'large-test-document.md';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--size' && args[i + 1]) {
      targetKB = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--output' && args[i + 1]) {
      outputPath = args[i + 1];
      i++;
    } else if (args[i] === '--help') {
      console.log(`
Usage: npx tsx generate-large-markdown.ts [options]

Options:
  --size <kb>      Target file size in KB (default: 100)
  --output <path>  Output file path (default: large-test-document.md)
  --help           Show this help message
`);
      process.exit(0);
    }
  }

  const targetBytes = targetKB * 1024;
  console.log(`Generating markdown file with target size: ${targetKB}KB...`);

  const content = generateMarkdown(targetBytes);
  const resolvedPath = path.resolve(outputPath);

  fs.writeFileSync(resolvedPath, content, 'utf8');

  const stats = fs.statSync(resolvedPath);
  const wordCount = content.split(/\s+/).length;

  console.log(`Created: ${resolvedPath}`);
  console.log(`Size: ${(stats.size / 1024).toFixed(2)}KB (${stats.size} bytes)`);
  console.log(`Words: ~${wordCount.toLocaleString()}`);
}

main();
