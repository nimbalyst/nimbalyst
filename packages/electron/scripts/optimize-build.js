#!/usr/bin/env node

/**
 * Build optimization script to reduce app size
 * Aggressively removes unnecessary files from the build
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Detect current platform and architecture
const platform = process.platform;
const arch = process.arch;
const platformKey = `${arch}-${platform}`;

console.log(`🎯 Optimizing build for ${platformKey}`);

/**
 * Remove unnecessary ripgrep binaries from claude-agent-sdk
 */
function optimizeClaudeCode() {
  // Check both local and monorepo root node_modules
  let claudeCodePath = path.join(__dirname, '../node_modules/@anthropic-ai/claude-agent-sdk');

  if (!fs.existsSync(claudeCodePath)) {
    // Try monorepo root
    claudeCodePath = path.join(__dirname, '../../../node_modules/@anthropic-ai/claude-agent-sdk');
  }

  if (!fs.existsSync(claudeCodePath)) {
    console.log('⚠️  claude-agent-sdk not found, skipping optimization');
    return;
  }

  const ripgrepPath = path.join(claudeCodePath, 'vendor/ripgrep');
  
  if (!fs.existsSync(ripgrepPath)) {
    console.log('⚠️  ripgrep vendor directory not found');
    return;
  }

  // List of all platform directories
  const platforms = [
    'arm64-darwin',
    'x64-darwin', 
    'arm64-linux',
    'x64-linux',
    'x64-win32'
  ];

  let totalSaved = 0;

  platforms.forEach(plat => {
    if (plat !== platformKey) {
      const platPath = path.join(ripgrepPath, plat);
      if (fs.existsSync(platPath)) {
        // Get size before deletion
        const size = getDirSize(platPath);
        totalSaved += size;
        
        // Remove the directory
        fs.rmSync(platPath, { recursive: true, force: true });
        console.log(`  ✅ Removed ${plat} (${formatBytes(size)})`);
      }
    }
  });

  // Also remove unnecessary vendor files
  const unnecessaryFiles = [
    'vendor/claude-code.vsix', // VSCode extension
    'vendor/claude-code-jetbrains-plugin' // JetBrains plugin
  ];

  unnecessaryFiles.forEach(file => {
    const filePath = path.join(claudeCodePath, file);
    if (fs.existsSync(filePath)) {
      const stats = fs.statSync(filePath);
      if (stats.isDirectory()) {
        const size = getDirSize(filePath);
        totalSaved += size;
        fs.rmSync(filePath, { recursive: true, force: true });
        console.log(`  ✅ Removed ${file} (${formatBytes(size)})`);
      } else {
        totalSaved += stats.size;
        fs.unlinkSync(filePath);
        console.log(`  ✅ Removed ${file} (${formatBytes(stats.size)})`);
      }
    }
  });

  console.log(`📦 Total space saved from claude-agent-sdk: ${formatBytes(totalSaved)}`);
}

/**
 * Get total size of a directory
 */
function getDirSize(dirPath) {
  let totalSize = 0;
  
  function walkDir(dir) {
    const files = fs.readdirSync(dir);
    files.forEach(file => {
      const filePath = path.join(dir, file);
      const stats = fs.statSync(filePath);
      if (stats.isDirectory()) {
        walkDir(filePath);
      } else {
        totalSize += stats.size;
      }
    });
  }
  
  walkDir(dirPath);
  return totalSize;
}

/**
 * Format bytes to human readable
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Remove unnecessary files from all node_modules
 */
function optimizeNodeModules() {
  const nodeModulesPath = path.join(__dirname, '../node_modules');
  
  if (!fs.existsSync(nodeModulesPath)) {
    console.log('⚠️  node_modules not found');
    return;
  }

  let totalSaved = 0;

  // Remove unnecessary file types across all packages
  const unnecessaryPatterns = [
    '**/*.md',        // Markdown files (except LICENSE)
    '**/*.markdown',
    '**/test/**',     // Test directories
    '**/tests/**',
    '**/__tests__/**',
    '**/example/**',  // Example directories
    '**/examples/**',
    '**/docs/**',     // Documentation
    '**/.github/**',  // GitHub specific files
    '**/*.map',       // Source maps (we don't need in production)
    '**/*.ts',        // TypeScript source files (keeping only .js)
    '**/*.tsx',
    '**/tsconfig.json',
    '**/.eslintrc*',
    '**/.prettierrc*',
    '**/.editorconfig',
    '**/CHANGELOG*',
    '**/AUTHORS*',
    '**/CONTRIBUTORS*',
    '**/*.test.js',
    '**/*.spec.js',
  ];

  // Walk through node_modules and remove unnecessary files
  function walkAndClean(dir, isRoot = false) {
    const files = fs.readdirSync(dir);
    
    for (const file of files) {
      if (file === '.bin' && isRoot) continue; // Keep .bin in root node_modules
      
      const filePath = path.join(dir, file);
      const stats = fs.statSync(filePath);
      
      if (stats.isDirectory()) {
        // Skip certain critical directories
        if (file === 'node_modules' && !isRoot) continue;
        
        walkAndClean(filePath);
      } else {
        // Check if file matches unnecessary patterns
        const shouldRemove = 
          file.endsWith('.md') && !file.toLowerCase().includes('license') ||
          file.endsWith('.markdown') ||
          file.endsWith('.map') ||
          file.endsWith('.ts') && !file.endsWith('.d.ts') ||
          file.endsWith('.tsx') ||
          file === 'tsconfig.json' ||
          file.startsWith('.eslintrc') ||
          file.startsWith('.prettierrc') ||
          file === '.editorconfig' ||
          file.startsWith('CHANGELOG') ||
          file.startsWith('AUTHORS') ||
          file.startsWith('CONTRIBUTORS') ||
          file.endsWith('.test.js') ||
          file.endsWith('.spec.js');
        
        if (shouldRemove) {
          totalSaved += stats.size;
          fs.unlinkSync(filePath);
        }
      }
    }
    
    // Remove empty directories
    try {
      const remainingFiles = fs.readdirSync(dir);
      if (remainingFiles.length === 0 && !isRoot) {
        fs.rmdirSync(dir);
      }
    } catch (e) {
      // Directory might already be deleted
    }
  }

  walkAndClean(nodeModulesPath, true);
  console.log(`  ✅ Cleaned node_modules (${formatBytes(totalSaved)} saved)`);
}

/**
 * Remove unnecessary native modules for other platforms
 */
function optimizeNativeModules() {
  const nodeModulesPath = path.join(__dirname, '../node_modules');
  
  if (!fs.existsSync(nodeModulesPath)) {
    return;
  }

  let totalSaved = 0;

  // Platform-specific file patterns to remove
  const platformPatterns = {
    'darwin': ['*.dll', '*.exe', '*.lib', 'linux-*', 'win32-*'],
    'win32': ['*.dylib', '*.so', 'darwin-*', 'linux-*'],
    'linux': ['*.dylib', '*.dll', '*.exe', 'darwin-*', 'win32-*']
  };

  const patternsToRemove = platformPatterns[platform] || [];

  function removeIfMatches(filePath) {
    const fileName = path.basename(filePath);
    for (const pattern of patternsToRemove) {
      if (pattern.includes('*')) {
        const regex = new RegExp(pattern.replace('*', '.*'));
        if (regex.test(fileName)) {
          const stats = fs.statSync(filePath);
          totalSaved += stats.size;
          fs.unlinkSync(filePath);
          return true;
        }
      } else if (fileName === pattern) {
        const stats = fs.statSync(filePath);
        totalSaved += stats.size;
        fs.unlinkSync(filePath);
        return true;
      }
    }
    return false;
  }

  function walkAndRemove(dir) {
    try {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        const filePath = path.join(dir, file);
        const stats = fs.statSync(filePath);
        
        if (stats.isDirectory()) {
          walkAndRemove(filePath);
        } else {
          removeIfMatches(filePath);
        }
      }
    } catch (e) {
      // Directory might not exist or be accessible
    }
  }

  walkAndRemove(nodeModulesPath);
  
  if (totalSaved > 0) {
    console.log(`  ✅ Removed other platform binaries (${formatBytes(totalSaved)} saved)`);
  }
}

/**
 * Main optimization function
 */
function optimize() {
  console.log('🚀 Starting aggressive build optimization...\n');
  
  // Optimize claude-agent-sdk package
  console.log('📦 Optimizing claude-agent-sdk package...');
  optimizeClaudeCode();
  
  // Clean up node_modules
  console.log('\n🧹 Cleaning node_modules...');
  optimizeNodeModules();
  
  // Remove other platform native modules
  console.log('\n🔧 Removing unnecessary native modules...');
  optimizeNativeModules();
  
  console.log('\n✨ Build optimization complete!');
}

// Run optimization
optimize();