/**
 * Bash command parsing utilities for file operation detection and security checks
 * Used by agent providers to track file modifications and validate compound commands
 */

import path from 'path';
import { parse as parseShellCommand, quote as quoteShellArgs } from 'shell-quote';

/**
 * Check if a command contains shell chaining operators (&&, ||, ;)
 * Uses shell-quote library for proper parsing that handles quotes; heredoc
 * bodies are stripped first because they are data, not shell
 *
 * @param command - The Bash command to check
 * @returns True if command contains chaining operators
 */
export function hasShellChainingOperators(command: string): boolean {
  try {
    const parsed = parseShellCommand(stripHeredocs(command));
    // shell-quote returns operators as { op: '&&' } objects
    return parsed.some(token =>
      typeof token === 'object' &&
      token !== null &&
      'op' in token &&
      ['&&', '||', ';'].includes(token.op)
    );
  } catch {
    // If parsing fails, fall back to simple regex (less accurate but safe)
    return /\s*&&\s*|\s*\|\|\s*|\s*;\s*/.test(command);
  }
}

/**
 * Split a command on shell chaining operators (&&, ||, ;)
 * Uses shell-quote library for proper parsing that handles quotes; heredoc
 * bodies are stripped first so their lines never become sub-commands.
 *
 * Each sub-command is re-serialized with its words re-quoted, so a quoted
 * argument that contains an operator (`sed 's|a||;s|b||'`) stays one
 * argument and the sub-command is not itself mistaken for a compound command.
 *
 * @param command - The Bash command to split
 * @returns Array of individual commands
 */
export function splitOnShellOperators(command: string): string[] {
  try {
    const parsed = parseShellCommand(stripHeredocs(command));
    const commands: string[] = [];
    let currentTokens: string[] = [];

    for (const token of parsed) {
      if (typeof token === 'object' && token !== null && 'op' in token) {
        // This is an operator
        if (['&&', '||', ';'].includes(token.op)) {
          // Chaining operator - flush current command
          if (currentTokens.length > 0) {
            commands.push(currentTokens.join(' '));
            currentTokens = [];
          }
        } else if (token.op === 'glob' && 'pattern' in token) {
          // Unquoted glob such as src/*.md: keep the pattern, not the token type
          currentTokens.push(token.pattern as string);
        } else {
          // Other operators (|, >, <, etc.) - keep as part of current command
          currentTokens.push(token.op);
        }
      } else if (typeof token === 'string') {
        // Quote only words that would otherwise split or read as operators;
        // quote() also escapes @ = : ~ , which would change the part's pattern
        currentTokens.push(!/[\s;&|<>()'"`\\$#*?]/.test(token)
          ? token
          : token.includes("'") ? quoteShellArgs([token]) : `'${token}'`);
      }
      // Skip other token types (comments, etc.)
    }

    // Don't forget the last command
    if (currentTokens.length > 0) {
      commands.push(currentTokens.join(' '));
    }

    return commands.length > 0 ? commands : [command];
  } catch {
    // If parsing fails, return original command as single element
    return [command];
  }
}

/**
 * Strip heredoc body content from a command before parsing.
 * shell-quote doesn't understand heredocs, so content like:
 *   cat << 'EOF' > file.txt
 *   A --> B[Sporting]
 *   EOF
 * would have the body parsed as shell tokens, causing false positives
 * (e.g., --> interpreted as redirect operator, B[Sporting] as a file path).
 *
 * This preserves the first line (command + redirect) and only strips the
 * heredoc body (from the line after << DELIMITER to the closing DELIMITER).
 *
 * A << inside quotes or a comment is not a heredoc, and the lines after it
 * are real commands, so it is left alone. Permission checks rely on this:
 * `git status # <<A` followed by `rm -rf ~` must not hide the rm. After a
 * command substitution ($( or a backtick) quoting is too hard to follow
 * here, so nothing more is stripped; callers then see the extra lines.
 */
export function stripHeredocs(command: string): string {
  // Match: <<[-]? ['"]?WORD['"]? [rest of first line]\n[heredoc body]\nWORD
  // Capture group 1: the delimiter word
  // Capture group 2: the rest of the first line (e.g., "> file.txt")
  // Replace with just the rest of the first line, dropping the heredoc body
  const heredoc = /<<-?\s*['"]?(\w+)['"]?(.*)\n[\s\S]*?\n\s*\1\s*$/gm;
  let quote: '' | "'" | '"' = '';
  let inComment = false;
  let escaped = false;
  let sawSubstitution = false;

  // Track shell quoting state over command[from, to)
  const lex = (from: number, to: number) => {
    for (let i = from; i < to; i++) {
      const ch = command[i];
      if (inComment) {
        if (ch === '\n') inComment = false;
      } else if (escaped) {
        escaped = false;
      } else if (quote === "'") {
        if (ch === "'") quote = '';
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '`' || (ch === '$' && command[i + 1] === '(')) {
        sawSubstitution = true;
      } else if (quote === '"') {
        if (ch === '"') quote = '';
      } else if (ch === "'" || ch === '"') {
        quote = ch;
      } else if (ch === '#' && (i === 0 || /[\s;&|()<>]/.test(command[i - 1]))) {
        inComment = true;
      }
    }
  };

  let result = '';
  let copiedTo = 0;
  let lexedTo = 0;
  let match: RegExpExecArray | null;
  while ((match = heredoc.exec(command)) !== null) {
    lex(lexedTo, match.index);
    lexedTo = match.index;
    const isOperator = !quote && !inComment && !escaped && !sawSubstitution &&
      command[match.index - 1] !== '<' && command[match.index + 2] !== '<';
    if (!isOperator) {
      // Not a heredoc; look for another << further on
      heredoc.lastIndex = match.index + 1;
      continue;
    }
    result += command.slice(copiedTo, match.index) + match[2];
    // Quoting state carries over from the first line; the body is data
    const firstLineEnd = command.indexOf('\n', match.index);
    lex(match.index, firstLineEnd);
    inComment = false;
    escaped = false;
    copiedTo = lexedTo = match.index + match[0].length;
  }
  return result + command.slice(copiedTo);
}

/**
 * Parse a Bash command to detect file operations
 * Returns absolute paths to files that may be affected by the command
 *
 * Uses shell-quote for proper parsing that handles quotes and heredocs
 * Detects common file operations: >, >>, rm, mv, cp, sed -i, tee
 *
 * @param command - The Bash command to parse
 * @param cwd - Current working directory to resolve relative paths
 * @returns Array of absolute file paths that may be affected
 */
export function parseBashForFileOps(command: string, cwd: string): string[] {
  const files = new Set<string>();

  try {
    // Strip heredoc content before parsing - shell-quote doesn't handle heredocs
    // and will misinterpret their content (e.g., mermaid --> arrows as redirects)
    const cleanedCommand = stripHeredocs(command);
    const parsed = parseShellCommand(cleanedCommand);
    let currentCommand: string[] = [];
    let expectingRedirectTarget = false;
    let redirectOp: string | null = null;

    for (let i = 0; i < parsed.length; i++) {
      const token = parsed[i];

      // Handle operators
      if (typeof token === 'object' && token !== null && 'op' in token) {
        const op = token.op;

        // Track redirect operators
        if (op === '>' || op === '>>') {
          expectingRedirectTarget = true;
          redirectOp = op;
          continue;
        }

        // Reset on chaining operators
        if (['&&', '||', ';', '|'].includes(op)) {
          // Process the current command before resetting
          processCommand(currentCommand, files, cwd);
          currentCommand = [];
          expectingRedirectTarget = false;
          redirectOp = null;
          continue;
        }
      }

      // Handle redirect targets
      if (expectingRedirectTarget && typeof token === 'string') {
        addFileToSet(token, cwd, files);
        expectingRedirectTarget = false;
        redirectOp = null;
        continue;
      }

      // Collect tokens for command processing
      if (typeof token === 'string') {
        currentCommand.push(token);
      }
    }

    // Process the final command
    if (currentCommand.length > 0) {
      processCommand(currentCommand, files, cwd);
    }

  } catch {
    // If shell-quote parsing fails, fall back to regex patterns
    return parseBashForFileOpsRegex(command, cwd);
  }

  return Array.from(files);
}

/**
 * Process a command array to detect file operations
 * Helper for parseBashForFileOps
 */
function processCommand(tokens: string[], files: Set<string>, cwd: string): void {
  if (tokens.length === 0) return;

  const cmd = tokens[0];

  // rm command: rm [-rf] file
  if (cmd === 'rm') {
    for (let i = 1; i < tokens.length; i++) {
      const token = tokens[i];
      if (!token.startsWith('-')) {
        addFileToSet(token, cwd, files);
      }
    }
    return;
  }

  // mv command: mv [-if] source dest
  if (cmd === 'mv') {
    const args = tokens.slice(1).filter(t => !t.startsWith('-'));
    if (args.length >= 2) {
      addFileToSet(args[0], cwd, files); // source
      addFileToSet(args[1], cwd, files); // dest
    }
    return;
  }

  // cp command: cp [-rif] source dest (track dest only)
  if (cmd === 'cp') {
    const args = tokens.slice(1).filter(t => !t.startsWith('-'));
    if (args.length >= 2) {
      addFileToSet(args[args.length - 1], cwd, files); // dest
    }
    return;
  }

  // sed -i: sed -i[.bak] 's/.../' file
  if (cmd === 'sed') {
    let hasInPlace = false;
    for (let i = 1; i < tokens.length; i++) {
      if (tokens[i] === '-i' || tokens[i].startsWith('-i.')) {
        hasInPlace = true;
      } else if (hasInPlace && !tokens[i].startsWith('-') && !tokens[i].includes('/')) {
        // Last non-flag, non-pattern token is the file
        addFileToSet(tokens[i], cwd, files);
      }
    }
    return;
  }

  // tee: tee [-a] file
  if (cmd === 'tee') {
    for (let i = 1; i < tokens.length; i++) {
      const token = tokens[i];
      if (!token.startsWith('-')) {
        addFileToSet(token, cwd, files);
      }
    }
    return;
  }
}

/**
 * Add a file path to the set if it's valid and within workspace
 */
function addFileToSet(filePath: string, cwd: string, files: Set<string>): void {
  if (!filePath || filePath.startsWith('$')) return; // Skip variables

  // Reject paths that contain characters not found in real file paths.
  // This catches false positives from mermaid syntax (B[Sporting]),
  // URLs, and other non-path content that shell-quote misparses.
  if (/[\[\]{}()<>:;,!@#%^&*?|=+`"']/.test(filePath)) return;

  try {
    const absPath = path.resolve(cwd, filePath);
    if (absPath.startsWith(cwd)) {
      files.add(absPath);
    }
  } catch {
    // Invalid path, skip
  }
}

/**
 * Fallback regex-based parser when shell-quote fails
 * Uses the original Phase 1 implementation
 */
function parseBashForFileOpsRegex(command: string, cwd: string): string[] {
  const files = new Set<string>();

  // Strip heredoc content before regex parsing too
  const cleanedCommand = stripHeredocs(command);

  // Pattern 1: Output redirects (cat/echo > file, cat/echo >> file)
  const redirectPattern = /(?:cat|echo|printf)\s+.*?\s*(>>?)\s*([^\s;&|]+)/g;
  let match;
  while ((match = redirectPattern.exec(cleanedCommand)) !== null) {
    const filePath = match[2];
    if (filePath && !filePath.startsWith('$')) {
      try {
        const absPath = path.resolve(cwd, filePath);
        if (absPath.startsWith(cwd)) {
          files.add(absPath);
        }
      } catch (e) {
        // Invalid path, skip
      }
    }
  }

  // Pattern 2: Direct redirects
  const directRedirectPattern = /^\s*(>>?)\s*([^\s;&|]+)/gm;
  while ((match = directRedirectPattern.exec(cleanedCommand)) !== null) {
    const filePath = match[2];
    if (filePath && !filePath.startsWith('$')) {
      try {
        const absPath = path.resolve(cwd, filePath);
        if (absPath.startsWith(cwd)) {
          files.add(absPath);
        }
      } catch (e) {
        // Invalid path, skip
      }
    }
  }

  // Pattern 3: rm command
  const rmPattern = /\brm\s+(?:-[rf]+\s+)?([^\s;&|]+)/g;
  while ((match = rmPattern.exec(cleanedCommand)) !== null) {
    const filePath = match[1];
    if (filePath && !filePath.startsWith('$') && !filePath.startsWith('-')) {
      try {
        const absPath = path.resolve(cwd, filePath);
        if (absPath.startsWith(cwd)) {
          files.add(absPath);
        }
      } catch (e) {
        // Invalid path, skip
      }
    }
  }

  // Pattern 4: mv command
  const mvPattern = /\bmv\s+(?:-[if]+\s+)?([^\s;&|]+)\s+([^\s;&|]+)/g;
  while ((match = mvPattern.exec(cleanedCommand)) !== null) {
    const sourcePath = match[1];
    const destPath = match[2];

    if (sourcePath && !sourcePath.startsWith('$') && !sourcePath.startsWith('-')) {
      try {
        const absPath = path.resolve(cwd, sourcePath);
        if (absPath.startsWith(cwd)) {
          files.add(absPath);
        }
      } catch (e) {
        // Invalid path, skip
      }
    }

    if (destPath && !destPath.startsWith('$') && !destPath.startsWith('-')) {
      try {
        const absPath = path.resolve(cwd, destPath);
        if (absPath.startsWith(cwd)) {
          files.add(absPath);
        }
      } catch (e) {
        // Invalid path, skip
      }
    }
  }

  // Pattern 5: cp command
  const cpPattern = /\bcp\s+(?:-[rif]+\s+)?([^\s;&|]+)\s+([^\s;&|]+)/g;
  while ((match = cpPattern.exec(cleanedCommand)) !== null) {
    const destPath = match[2];

    if (destPath && !destPath.startsWith('$') && !destPath.startsWith('-')) {
      try {
        const absPath = path.resolve(cwd, destPath);
        if (absPath.startsWith(cwd)) {
          files.add(absPath);
        }
      } catch (e) {
        // Invalid path, skip
      }
    }
  }

  // Pattern 6: sed -i
  const sedPattern = /\bsed\s+-i(?:\.bak)?\s+(?:'[^']+'|"[^"]+")\s+([^\s;&|]+)/g;
  while ((match = sedPattern.exec(cleanedCommand)) !== null) {
    const filePath = match[1];
    if (filePath && !filePath.startsWith('$')) {
      try {
        const absPath = path.resolve(cwd, filePath);
        if (absPath.startsWith(cwd)) {
          files.add(absPath);
        }
      } catch (e) {
        // Invalid path, skip
      }
    }
  }

  // Pattern 7: tee
  const teePattern = /\btee\s+(?:-a\s+)?([^\s;&|]+)/g;
  while ((match = teePattern.exec(cleanedCommand)) !== null) {
    const filePath = match[1];
    if (filePath && !filePath.startsWith('$')) {
      try {
        const absPath = path.resolve(cwd, filePath);
        if (absPath.startsWith(cwd)) {
          files.add(absPath);
        }
      } catch (e) {
        // Invalid path, skip
      }
    }
  }

  return Array.from(files);
}
