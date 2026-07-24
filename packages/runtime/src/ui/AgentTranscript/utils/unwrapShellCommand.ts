/** Shell wrapper: /bin/zsh -lc 'cmd' or bare bash -lc 'cmd' (Windows inner layer) */
const SHELL_WRAPPER_REGEX = /^(?:\/(?:bin|usr\/bin)\/)?(?:bash|zsh|sh)\s+-l?c\s+([\s\S]+)$/;

/** Windows PowerShell wrapper: "C:\...\powershell.exe" -Command 'actual command' */
const POWERSHELL_REGEX = /^"?[A-Za-z]:\\[^"]*\\(?:powershell|pwsh)(?:\.exe)?"?\s+-Command\s+([\s\S]+)$/i;

/** Windows cmd.exe wrapper: cmd.exe /c "actual command" or cmd /c "actual command" */
const CMD_EXE_REGEX = /^"?(?:[A-Za-z]:\\[^"]*\\)?cmd(?:\.exe)?"?\s+\/[cC]\s+([\s\S]+)$/;

/** Strip matching outer quotes (single or double) from a string */
function stripOuterQuotes(s: string): string {
  return s.replace(/^(['"])([\s\S]*)\1$/, '$2');
}

/**
 * Unwrap a shell-wrapped command for display purposes.
 *
 * macOS/Linux: /bin/zsh -lc "sed -n '1,260p' file.ts"
 *   → sed -n '1,260p' file.ts
 *
 * Windows: "C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe" -Command 'bash -lc "cat diagram.md"'
 *   → cat diagram.md
 *
 * Windows: cmd.exe /c "bash -lc 'echo hello'"
 *   → echo hello
 *
 * Display-only — does not modify stored data.
 */
export function unwrapShellCommand(command: string | string[] | unknown): string {
  // ACP (and some Codex tool calls) send command as an argv array, e.g.
  // ["/bin/zsh", "-lc", "actual command"]. Join into a single string so the
  // existing wrapper regexes can strip the shell layer.
  if (Array.isArray(command)) {
    command = command.map(part => String(part ?? '')).join(' ');
  }
  if (typeof command !== 'string') {
    return String(command ?? '');
  }

  // Try cmd.exe wrapper
  const cmdMatch = command.match(CMD_EXE_REGEX);
  if (cmdMatch) {
    const inner = stripOuterQuotes(cmdMatch[1]);
    return unwrapShellCommand(inner);
  }

  // Try PowerShell wrapper first (may contain a nested Unix shell wrapper)
  const psMatch = command.match(POWERSHELL_REGEX);
  if (psMatch) {
    const inner = stripOuterQuotes(psMatch[1]);
    // Recurse to unwrap any nested shell wrapper (e.g. bash -lc "...")
    return unwrapShellCommand(inner);
  }

  // Try shell wrapper (with or without path prefix)
  const unixMatch = command.match(SHELL_WRAPPER_REGEX);
  if (unixMatch) {
    return stripOuterQuotes(unixMatch[1]);
  }

  return command;
}
