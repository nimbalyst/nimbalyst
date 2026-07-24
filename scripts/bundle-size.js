#!/usr/bin/env node

/**
 * Bundle size analysis tool for Nimbalyst
 * 
 * Usage:
 *   node scripts/bundle-size.js          # Basic analysis
 *   node scripts/bundle-size.js --top    # Show top 20 largest files
 *   node scripts/bundle-size.js --help   # Show help
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { gzipSync } from 'zlib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function analyzeBundle(showTop = false) {
  console.log(`\n${colors.cyan}📊 Building and analyzing bundle...${colors.reset}\n`);
  
  // Build the project
  try {
    execSync('pnpm run build-prod', { stdio: 'inherit' });
  } catch (error) {
    console.error(`${colors.red}Build failed!${colors.reset}`);
    process.exit(1);
  }
  
  const buildDir = path.join(__dirname, '..', 'build');
  const distDir = path.join(__dirname, '..', 'dist');
  
  // Check both possible output directories
  const outputDir = fs.existsSync(buildDir) ? buildDir : distDir;
  
  if (!fs.existsSync(outputDir)) {
    console.error(`${colors.red}Build output directory not found!${colors.reset}`);
    process.exit(1);
  }
  
  // Analyze files
  const files = [];
  let totalSize = 0;
  let totalGzipSize = 0;
  
  function scanDirectory(dir) {
    const items = fs.readdirSync(dir);
    
    for (const item of items) {
      const fullPath = path.join(dir, item);
      const stat = fs.statSync(fullPath);
      
      if (stat.isDirectory()) {
        scanDirectory(fullPath);
      } else if (stat.isFile() && !item.startsWith('.')) {
        const content = fs.readFileSync(fullPath);
        const gzipped = gzipSync(content).length;
        const fileInfo = {
          path: path.relative(outputDir, fullPath),
          size: stat.size,
          gzipSize: gzipped,
          type: path.extname(item).slice(1) || 'other'
        };
        
        files.push(fileInfo);
        totalSize += stat.size;
        totalGzipSize += gzipped;
      }
    }
  }
  
  scanDirectory(outputDir);
  
  // Sort by gzip size
  files.sort((a, b) => b.gzipSize - a.gzipSize);
  
  // Display results
  console.log(`\n${colors.bold}Bundle Size Summary${colors.reset}`);
  console.log('═'.repeat(50));
  console.log(`Total files: ${files.length}`);
  console.log(`Total size: ${formatBytes(totalSize)} (${formatBytes(totalGzipSize)} gzipped)`);
  console.log(`Compression ratio: ${((totalGzipSize / totalSize) * 100).toFixed(1)}%`);
  
  // Group by type
  const byType = {};
  for (const file of files) {
    if (!byType[file.type]) {
      byType[file.type] = { count: 0, size: 0, gzipSize: 0 };
    }
    byType[file.type].count++;
    byType[file.type].size += file.size;
    byType[file.type].gzipSize += file.gzipSize;
  }
  
  console.log(`\n${colors.bold}By Type${colors.reset}`);
  console.log('─'.repeat(50));
  for (const [type, stats] of Object.entries(byType)) {
    console.log(
      `${type.padEnd(10)} ${String(stats.count).padStart(4)} files  ` +
      `${formatBytes(stats.size).padStart(10)} (${formatBytes(stats.gzipSize).padStart(10)} gzipped)`
    );
  }
  
  if (showTop) {
    console.log(`\n${colors.bold}Top 20 Largest Files (by gzipped size)${colors.reset}`);
    console.log('─'.repeat(80));
    console.log('File'.padEnd(50) + 'Size'.padStart(12) + 'Gzipped'.padStart(12));
    console.log('─'.repeat(80));
    
    for (const file of files.slice(0, 20)) {
      const name = file.path.length > 47 ? '...' + file.path.slice(-44) : file.path;
      console.log(
        name.padEnd(50) +
        formatBytes(file.size).padStart(12) +
        formatBytes(file.gzipSize).padStart(12)
      );
    }
  }
  
  // Warnings
  console.log(`\n${colors.bold}Warnings${colors.reset}`);
  const largeFiles = files.filter(f => f.gzipSize > 100 * 1024); // > 100KB gzipped
  if (largeFiles.length > 0) {
    console.log(`${colors.yellow}⚠️  ${largeFiles.length} files are larger than 100KB gzipped${colors.reset}`);
  }
  
  const jsFiles = files.filter(f => f.type === 'js');
  const largestJs = jsFiles[0];
  if (largestJs && largestJs.gzipSize > 500 * 1024) {
    console.log(`${colors.yellow}⚠️  Largest JS file is ${formatBytes(largestJs.gzipSize)} gzipped${colors.reset}`);
  }
  
  if (totalGzipSize > 2 * 1024 * 1024) {
    console.log(`${colors.red}⚠️  Total bundle exceeds 2MB gzipped!${colors.reset}`);
  } else {
    console.log(`${colors.green}✓ Bundle size is under control${colors.reset}`);
  }
}

// Parse arguments
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(`
Bundle Size Analysis Tool

Usage:
  node scripts/bundle-size.js          # Basic analysis
  node scripts/bundle-size.js --top    # Show top 20 largest files
  node scripts/bundle-size.js --help   # Show this help

This tool builds the production bundle and analyzes its size composition.
  `);
  process.exit(0);
}

analyzeBundle(args.includes('--top'));