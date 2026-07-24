#!/usr/bin/env node

/**
 * Analyze the app bundle size and show what's taking space
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Colors for terminal output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m'
};

/**
 * Format bytes to human readable
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Get size of directory or file
 */
function getSize(itemPath) {
  if (!fs.existsSync(itemPath)) return 0;
  
  const stats = fs.statSync(itemPath);
  if (!stats.isDirectory()) return stats.size;
  
  let totalSize = 0;
  const files = fs.readdirSync(itemPath);
  
  for (const file of files) {
    const filePath = path.join(itemPath, file);
    const fileStats = fs.statSync(filePath);
    
    if (fileStats.isDirectory()) {
      totalSize += getSize(filePath);
    } else {
      totalSize += fileStats.size;
    }
  }
  
  return totalSize;
}

/**
 * Analyze node_modules
 */
function analyzeNodeModules() {
  const nodeModulesPath = path.join(__dirname, '../node_modules');
  
  if (!fs.existsSync(nodeModulesPath)) {
    console.log('node_modules not found');
    return;
  }
  
  const packages = [];
  const dirs = fs.readdirSync(nodeModulesPath);
  
  for (const dir of dirs) {
    if (dir.startsWith('.')) continue;
    
    const dirPath = path.join(nodeModulesPath, dir);
    const stats = fs.statSync(dirPath);
    
    if (stats.isDirectory()) {
      if (dir.startsWith('@')) {
        // Handle scoped packages
        const scopedDirs = fs.readdirSync(dirPath);
        for (const scopedDir of scopedDirs) {
          const scopedPath = path.join(dirPath, scopedDir);
          const size = getSize(scopedPath);
          packages.push({
            name: `${dir}/${scopedDir}`,
            size: size,
            path: scopedPath
          });
        }
      } else {
        const size = getSize(dirPath);
        packages.push({
          name: dir,
          size: size,
          path: dirPath
        });
      }
    }
  }
  
  // Sort by size
  packages.sort((a, b) => b.size - a.size);
  
  console.log(`\n${colors.bright}📦 Top 20 Largest Dependencies:${colors.reset}\n`);
  
  const top20 = packages.slice(0, 20);
  let totalSize = 0;
  
  for (const pkg of top20) {
    totalSize += pkg.size;
    const sizeStr = formatBytes(pkg.size).padStart(10);
    
    let color = colors.green;
    if (pkg.size > 50 * 1024 * 1024) color = colors.red; // > 50MB
    else if (pkg.size > 10 * 1024 * 1024) color = colors.yellow; // > 10MB
    
    console.log(`${color}${sizeStr}${colors.reset}  ${pkg.name}`);
    
    // Check for specific problem areas
    if (pkg.name === '@anthropic-ai/claude-agent-sdk') {
      // Check vendor directory
      const vendorPath = path.join(pkg.path, 'vendor');
      if (fs.existsSync(vendorPath)) {
        const ripgrepPath = path.join(vendorPath, 'ripgrep');
        if (fs.existsSync(ripgrepPath)) {
          const platforms = fs.readdirSync(ripgrepPath);
          console.log(`${colors.cyan}            └─ ripgrep binaries:${colors.reset}`);
          for (const platform of platforms) {
            if (!platform.startsWith('.') && platform !== 'COPYING') {
              const platPath = path.join(ripgrepPath, platform);
              const platSize = getSize(platPath);
              console.log(`${colors.cyan}               • ${platform}: ${formatBytes(platSize)}${colors.reset}`);
            }
          }
        }
      }
    }
  }
  
  console.log(`\n${colors.bright}Total size of top 20:${colors.reset} ${formatBytes(totalSize)}`);
  
  const allSize = packages.reduce((sum, pkg) => sum + pkg.size, 0);
  console.log(`${colors.bright}Total node_modules:${colors.reset} ${formatBytes(allSize)}`);
}

/**
 * Analyze release build
 */
function analyzeRelease() {
  const releasePath = path.join(__dirname, '../release');
  
  if (!fs.existsSync(releasePath)) {
    console.log(`\n${colors.yellow}No release build found. Run 'npm run build:mac' first.${colors.reset}`);
    return;
  }
  
  // Find .app bundle
  const macPath = path.join(releasePath, 'mac-arm64');
  const appPath = path.join(macPath, 'Nimbalyst.app');
  
  if (fs.existsSync(appPath)) {
    console.log(`\n${colors.bright}📱 App Bundle Analysis:${colors.reset}\n`);
    
    const appSize = getSize(appPath);
    console.log(`${colors.bright}Total app size:${colors.reset} ${formatBytes(appSize)}`);
    
    // Check key directories
    const dirs = [
      { path: 'Contents/Resources/app.asar', name: 'app.asar' },
      { path: 'Contents/Resources/app.asar.unpacked', name: 'app.asar.unpacked' },
      { path: 'Contents/Frameworks', name: 'Frameworks' },
      { path: 'Contents/MacOS', name: 'MacOS' }
    ];
    
    console.log(`\n${colors.bright}Breakdown:${colors.reset}`);
    
    for (const dir of dirs) {
      const dirPath = path.join(appPath, dir.path);
      if (fs.existsSync(dirPath)) {
        const size = getSize(dirPath);
        console.log(`  ${formatBytes(size).padStart(10)}  ${dir.name}`);
        
        // Check unpacked node_modules
        if (dir.name === 'app.asar.unpacked') {
          const unpackedModules = path.join(dirPath, 'node_modules');
          if (fs.existsSync(unpackedModules)) {
            const claudeCode = path.join(unpackedModules, '@anthropic-ai/claude-agent-sdk');
            if (fs.existsSync(claudeCode)) {
              const ccSize = getSize(claudeCode);
              console.log(`${colors.cyan}              └─ @anthropic-ai/claude-agent-sdk: ${formatBytes(ccSize)}${colors.reset}`);
            }
          }
        }
      }
    }
  }
  
  // Check DMG
  const dmgFiles = fs.readdirSync(releasePath).filter(f => f.endsWith('.dmg'));
  if (dmgFiles.length > 0) {
    console.log(`\n${colors.bright}💿 Distribution Files:${colors.reset}`);
    for (const dmg of dmgFiles) {
      const dmgPath = path.join(releasePath, dmg);
      const size = getSize(dmgPath);
      console.log(`  ${formatBytes(size).padStart(10)}  ${dmg}`);
    }
  }
}

/**
 * Main function
 */
function main() {
  console.log(`${colors.bright}${colors.blue}🔍 Nimbalyst Size Analysis${colors.reset}\n`);
  
  analyzeNodeModules();
  analyzeRelease();
  
  console.log(`\n${colors.bright}💡 Optimization Tips:${colors.reset}`);
  console.log('1. Run "npm run optimize" to remove unnecessary platform binaries');
  console.log('2. Consider installing @anthropic-ai/claude-agent-sdk globally instead of bundling');
  console.log('3. Use production builds with minification enabled');
  console.log('');
}

// Run analysis
main();