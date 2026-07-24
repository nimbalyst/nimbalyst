/**
 * Centralized file and directory filtering logic
 *
 * This module provides consistent filtering across all file operations
 * to ensure we exclude worktrees, build artifacts, and other undesired files/directories.
 */

import { hasCustomEditor } from '../extensions/RegisteredFileTypes';

// File extensions to exclude from search and scanning
// Note: Extensions with custom editors (like .pdf) are allowed even if in this list
export const EXCLUDED_EXTENSIONS = new Set([
  '.mp3', '.mp4', '.avi', '.mov', '.wmv',
  '.zip', '.tar', '.gz', '.rar', '.7z',
  '.exe', '.dll', '.so', '.dylib',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.db', '.sqlite', '.lock',
  '.pem', '.key', '.wallet'
]);

// Directories to exclude from scanning and search
export const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  '.worktrees',     // Git worktrees - CRITICAL: prevents duplicate file references
  'worktrees',      // Git worktrees (without dot) - CRITICAL: prevents duplicate file references
  'dist',
  'build',
  '.build',         // Swift Package Manager build artifacts
  'out',
  '.next',
  '.nuxt',
  '.cache',
  'coverage',
  '.vscode',
  '.idea',
  '__pycache__',
  '.DS_Store',
  '.venv',          // Python virtual environments
  'venv',           // Python virtual environments (without dot)
  '.env',           // Virtual environments
  'env',            // Virtual environments
  '.tox',           // Python tox testing environments
  'target',         // Rust/Java build output
  '.gradle',        // Gradle cache
  '.maven',         // Maven cache
  'vendor',         // PHP/Go dependencies
  'Pods',           // iOS CocoaPods
  '.swiftpm',       // Swift Package Manager metadata
  'DerivedData',    // Xcode build artifacts
]);

/**
 * Check if a file should be excluded based on extension.
 * Returns false if the file type has a custom editor registered via an extension.
 */
export function shouldExcludeFile(filePath: string): boolean {
  const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();

  // If in excluded list, check if there's a custom editor for it
  if (EXCLUDED_EXTENSIONS.has(ext)) {
    // Allow if there's a custom editor registered
    if (hasCustomEditor(filePath)) {
      return false;
    }
    return true;
  }

  return false;
}

/**
 * Check if a directory should be excluded
 */
export function shouldExcludeDir(dirName: string): boolean {
  return EXCLUDED_DIRS.has(dirName);
}

/**
 * Check if a path component contains an excluded directory
 * Useful for checking full paths to ensure no part of the path contains excluded dirs
 */
export function pathContainsExcludedDir(fullPath: string): boolean {
  const parts = fullPath.split(/[/\\]/);
  return parts.some(part => shouldExcludeDir(part));
}

/**
 * Glob patterns for excluding directories
 */
export const GLOB_EXCLUDE_PATTERNS = [
  '**/node_modules/**',
  '**/.git/**',
  '**/.worktrees/**',
  '**/worktrees/**',
  '**/dist/**',
  '**/build/**',
  '**/.build/**',
  '**/out/**',
  '**/.next/**',
  '**/.nuxt/**',
  '**/.cache/**',
  '**/coverage/**',
  '**/.vscode/**',
  '**/.idea/**',
  '**/__pycache__/**',
  '**/.DS_Store/**',
  '**/.venv/**',
  '**/venv/**',
  '**/.env/**',
  '**/env/**',
  '**/.tox/**',
  '**/target/**',
  '**/.gradle/**',
  '**/.maven/**',
  '**/vendor/**',
  '**/Pods/**',
  '**/.swiftpm/**',
  '**/DerivedData/**'
];

/**
 * Ripgrep glob arguments for excluding directories (as plain string to avoid bundler issues)
 */
export const RIPGREP_EXCLUDE_ARGS = '--glob !**/node_modules/** --glob !**/.git/** --glob !**/.worktrees/** --glob !**/worktrees/** --glob !**/dist/** --glob !**/build/** --glob !**/.build/** --glob !**/out/** --glob !**/.next/** --glob !**/.nuxt/** --glob !**/.cache/** --glob !**/coverage/** --glob !**/.vscode/** --glob !**/.idea/** --glob !**/__pycache__/** --glob !**/.DS_Store/** --glob !**/.venv/** --glob !**/venv/** --glob !**/.env/** --glob !**/env/** --glob !**/.tox/** --glob !**/target/** --glob !**/.gradle/** --glob !**/.maven/** --glob !**/vendor/** --glob !**/Pods/** --glob !**/.swiftpm/** --glob !**/DerivedData/**';

/**
 * Ripgrep file type arguments for QuickOpen content search
 * Currently empty - relies on exclude globs for filtering
 */
export const QUICKOPEN_FILE_TYPE_ARGS: string[] = [];

/**
 * Ripgrep glob arguments as array for use with execFile (cross-platform)
 */
export const RIPGREP_EXCLUDE_ARGS_ARRAY = [
    '--glob', '!**/node_modules/**',
    '--glob', '!**/.git/**',
    '--glob', '!**/.worktrees/**',
    '--glob', '!**/worktrees/**',
    '--glob', '!**/dist/**',
    '--glob', '!**/build/**',
    '--glob', '!**/.build/**',
    '--glob', '!**/out/**',
    '--glob', '!**/.next/**',
    '--glob', '!**/.nuxt/**',
    '--glob', '!**/.cache/**',
    '--glob', '!**/coverage/**',
    '--glob', '!**/.vscode/**',
    '--glob', '!**/.idea/**',
    '--glob', '!**/__pycache__/**',
    '--glob', '!**/.DS_Store/**',
    '--glob', '!**/.venv/**',
    '--glob', '!**/venv/**',
    '--glob', '!**/.env/**',
    '--glob', '!**/env/**',
    '--glob', '!**/.tox/**',
    '--glob', '!**/target/**',
    '--glob', '!**/.gradle/**',
    '--glob', '!**/.maven/**',
    '--glob', '!**/vendor/**',
    '--glob', '!**/Pods/**',
    '--glob', '!**/.swiftpm/**',
    '--glob', '!**/DerivedData/**'
];

/**
 * Find command prune arguments for excluding directories
 */
export const FIND_PRUNE_ARGS = '\\( -path "*/node_modules/*" -o -path "*/.git/*" -o -path "*/.worktrees/*" -o -path "*/worktrees/*" -o -path "*/dist/*" -o -path "*/build/*" -o -path "*/.build/*" -o -path "*/out/*" -o -path "*/.next/*" -o -path "*/.nuxt/*" -o -path "*/.cache/*" -o -path "*/coverage/*" -o -path "*/.vscode/*" -o -path "*/.idea/*" -o -path "*/__pycache__/*" -o -path "*/.DS_Store/*" -o -path "*/.venv/*" -o -path "*/venv/*" -o -path "*/.env/*" -o -path "*/env/*" -o -path "*/.tox/*" -o -path "*/target/*" -o -path "*/.gradle/*" -o -path "*/.maven/*" -o -path "*/vendor/*" -o -path "*/Pods/*" -o -path "*/.swiftpm/*" -o -path "*/DerivedData/*" \\) -prune -o';
