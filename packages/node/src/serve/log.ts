/**
 * One line per state transition, on stderr.
 *
 * stdout belongs to the one-turn CLI's streamed assistant text; a long-running
 * `serve` process writes nothing there. Fields are rendered `key=value` so a
 * container log scraper can read them without a JSON parser, and values are
 * truncated because an unbounded prompt or git error would otherwise wrap the
 * transition marker off the top of the line.
 *
 * Nothing here may carry a token, a refresh secret, or an encryption seed. Log
 * ids -- `nodeId`, `deviceId`, `sessionId`, `requestId` -- not credentials.
 */

export type Logger = (event: string, fields?: Record<string, unknown>) => void;

const MAX_VALUE_LENGTH = 200;

function render(value: unknown): string {
  const text = value instanceof Error
    ? value.message
    : typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  const collapsed = text.replace(/\s+/g, ' ').trim();
  const clipped = collapsed.length > MAX_VALUE_LENGTH
    ? `${collapsed.slice(0, MAX_VALUE_LENGTH)}...`
    : collapsed;
  return /[\s"]/.test(clipped) ? JSON.stringify(clipped) : clipped;
}

export function createStderrLogger(
  write: (line: string) => void = (line) => process.stderr.write(line),
): Logger {
  return (event, fields) => {
    const rendered = Object.entries(fields ?? {})
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => ` ${key}=${render(value)}`)
      .join('');
    write(`[nimbalyst-node] ${event}${rendered}\n`);
  };
}
