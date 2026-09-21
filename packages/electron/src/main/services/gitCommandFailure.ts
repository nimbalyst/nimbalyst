/** Keep transport failures ahead of incidental hook stderr in the Output panel. */
export function describeGitConnectionFailure(args: string[], stderr: string): string | undefined {
  const disconnected = stderr.match(/^Connection to [^\r\n]+ closed by remote host\.(?=\r?$)/m);
  if (!disconnected) return undefined;
  return `git ${args[0]} lost its SSH connection: ${disconnected[0]}`;
}

/** A signal identifies how Git stopped, but does not prove who caused it. */
export function describeSignalExit(args: string[], signal: string, stderr: string): string {
  const tail = stderr
    .trim()
    .split("\n")
    .filter((line) => !line.startsWith("    at "))
    .slice(-12)
    .join("\n");
  const connectionFailure = describeGitConnectionFailure(args, stderr);
  return (
    (connectionFailure ? `${connectionFailure}\n` : "") +
    `git ${args[0]} was terminated by ${signal} before it finished.` +
    (tail ? `\n\nLast output:\n${tail}` : "")
  );
}
