/**
 * Wrap text in single quotes so a POSIX shell reads it back exactly.
 *
 * Inside single quotes the shell treats every character as plain text, except
 * a single quote itself. Each single quote therefore becomes '\'' : close the
 * quote, add one escaped quote, open the quote again.
 */
export function shellQuote(text: string): string {
  return `'${text.split("'").join("'\\''")}'`;
}
