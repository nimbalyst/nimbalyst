/**
 * SafePathValidator - Comprehensive path validation for filesystem security
 *
 * This class provides robust validation to prevent path traversal attacks,
 * command injection, and unauthorized file system access.
 */

import { resolve, normalize, isAbsolute, parse, sep } from 'path';
import { logger } from '../utils/logger';

export interface PathValidationResult {
  isValid: boolean;
  sanitizedPath?: string;
  error?: string;
  violations?: string[];
}

export class SafePathValidator {
  private workspacePath: string;
  private resolvedWorkspace: string;

  // Dangerous patterns that should never appear in paths
  private static readonly DANGEROUS_PATTERNS = [
    /\.\./,                    // Parent directory traversal
    /^\//,                     // Absolute path (Unix)
    /^[A-Za-z]:\\/,           // Absolute path (Windows)
    /^\\\\/,                  // UNC/network share paths
    /\0/,                      // Null bytes
    /[<>"|?*]/,               // Invalid/dangerous characters
    /[;&]/,                   // Shell command separators
    /&&|\|\|/,                // Shell logical operators
    /\$\{.*\}/,               // Template injection
    /\$\(.*\)/,               // Command substitution
    /`.*`/,                    // Backtick command substitution
  ];

  // Paths that should never be accessed (relative to home or root)
  private static readonly FORBIDDEN_PATHS = [
    '.ssh',
    '.aws',
    '.gnupg',
    '.docker',
    '.kube',
    '.npm',
    '.gitconfig',
    '.bash_history',
    '.zsh_history',
    'Library/Keychains',
    'Library/Cookies',
    'AppData/Local/Google/Chrome',
    'AppData/Roaming/Mozilla',
  ];

  // File extensions that should be blocked
  private static readonly BLOCKED_EXTENSIONS = new Set([
    '.pem', '.key', '.cert', '.crt',           // Certificates/keys
    '.env', '.env.local', '.env.production',   // Environment files with secrets
    '.sqlite', '.db', '.sqlite3',              // Databases
    '.keychain', '.keystore',                  // Key stores
    '.wallet',                                  // Cryptocurrency wallets
  ]);

  // Dotfiles without extensions that still contain secrets.
  private static readonly BLOCKED_BASENAMES = new Set([
    '.env',
    '.env.local',
    '.env.production',
  ]);

  constructor(workspacePath: string) {
    if (!workspacePath) {
      throw new Error('Workspace path is required');
    }

    // Resolve and normalize the workspace path once
    this.workspacePath = normalize(workspacePath);
    this.resolvedWorkspace = resolve(this.workspacePath);

    // Validate that workspace itself is safe
    if (this.isSystemPath(this.resolvedWorkspace)) {
      throw new Error('Workspace cannot be in a system directory');
    }

    // logger.ai.info('[SafePathValidator] Initialized with workspace:', this.resolvedWorkspace);
  }

  /**
   * Validate a path for safe filesystem access
   */
  validate(inputPath: string | undefined | null): PathValidationResult {
    const violations: string[] = [];

    // Check for empty/invalid input
    if (!inputPath || typeof inputPath !== 'string') {
      return {
        isValid: false,
        error: 'Invalid or empty path provided',
        violations: ['empty_path']
      };
    }

    // Check for dangerous patterns
    for (const pattern of SafePathValidator.DANGEROUS_PATTERNS) {
      if (pattern.test(inputPath)) {
        violations.push(`dangerous_pattern:${pattern.source}`);
      }
    }

    // Check for absolute paths
    if (isAbsolute(inputPath)) {
      violations.push('absolute_path');
    }

    // Early return if dangerous patterns found
    if (violations.length > 0) {
      logger.ai.warn('[SafePathValidator] Path validation failed:', {
        path: inputPath,
        violations
      });
      return {
        isValid: false,
        error: 'Path contains dangerous patterns',
        violations
      };
    }

    // Normalize the path to remove redundant elements
    const normalizedPath = normalize(inputPath);

    // Join with workspace and resolve
    const fullPath = resolve(this.resolvedWorkspace, normalizedPath);

    // Critical check: Ensure resolved path is within workspace
    if (!fullPath.startsWith(this.resolvedWorkspace)) {
      violations.push('path_traversal');
      logger.ai.error('[SafePathValidator] Path traversal attempt detected:', {
        inputPath,
        resolvedPath: fullPath,
        workspace: this.resolvedWorkspace
      });
      return {
        isValid: false,
        error: 'Path traversal attempt detected',
        violations
      };
    }

    // Check for forbidden paths
    if (this.isForbiddenPath(fullPath)) {
      violations.push('forbidden_path');
      return {
        isValid: false,
        error: 'Access to this path is forbidden',
        violations
      };
    }

    // Check for blocked file extensions
    const parsed = parse(fullPath);
    const lowerExt = parsed.ext.toLowerCase();
    const lowerBase = parsed.base.toLowerCase();
    if (
      SafePathValidator.BLOCKED_EXTENSIONS.has(lowerExt) ||
      SafePathValidator.BLOCKED_BASENAMES.has(lowerBase)
    ) {
      violations.push(`blocked_extension:${parsed.ext}`);
      return {
        isValid: false,
        error: `File type ${parsed.ext} is not allowed`,
        violations
      };
    }

    // Calculate safe relative path from workspace
    const safePath = fullPath.substring(this.resolvedWorkspace.length + 1);

    logger.ai.debug('[SafePathValidator] Path validated successfully:', {
      input: inputPath,
      sanitized: safePath
    });

    return {
      isValid: true,
      sanitizedPath: safePath || '.'
    };
  }

  /**
   * Validate multiple paths at once
   */
  validateAll(paths: string[]): Map<string, PathValidationResult> {
    const results = new Map<string, PathValidationResult>();
    for (const path of paths) {
      results.set(path, this.validate(path));
    }
    return results;
  }

  /**
   * Check if path points to a system directory
   */
  private isSystemPath(path: string): boolean {
    const systemPaths = [
      '/System',
      '/Library',
      '/usr',
      '/bin',
      '/sbin',
      '/etc',
      'C:\\Windows',
      'C:\\Program Files',
      'C:\\ProgramData',
    ];

    // Allow temp directories and user-specific directories
    const allowedPrefixes = [
      '/var/folders',  // macOS temp directories
      '/tmp',          // Unix temp
      '/private/tmp',  // macOS temp
      '/private/var/folders', // macOS temp
      '/Users',        // macOS user directories
      '/home',         // Linux user directories
      'C:\\Users',     // Windows user directories
      'C:\\Temp',      // Windows temp
    ];

    const lowerPath = path.toLowerCase();

    // Check if it's in an allowed location first
    if (allowedPrefixes.some(allowed => path.startsWith(allowed))) {
      return false;
    }

    // Check if it's a system path
    return systemPaths.some(sysPath =>
      lowerPath === sysPath.toLowerCase() ||
      lowerPath.startsWith(sysPath.toLowerCase() + sep)
    );
  }

  /**
   * Check if path contains forbidden directories
   */
  private isForbiddenPath(path: string): boolean {
    const pathComponents = path.split(sep);

    for (const forbidden of SafePathValidator.FORBIDDEN_PATHS) {
      const forbiddenParts = forbidden.split('/');

      // Check if the path contains this forbidden sequence
      for (let i = 0; i <= pathComponents.length - forbiddenParts.length; i++) {
        const slice = pathComponents.slice(i, i + forbiddenParts.length);
        if (slice.every((part, idx) => part === forbiddenParts[idx])) {
          logger.ai.warn('[SafePathValidator] Forbidden path detected:', {
            path,
            forbidden
          });
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Get a safe version of a path for logging (doesn't expose full paths)
   */
  static getSafeLogPath(path: string): string {
    // Only show the last 2 components of the path for logging
    const parts = path.split(sep);
    if (parts.length <= 2) {
      return path;
    }
    return '.../' + parts.slice(-2).join('/');
  }
}
