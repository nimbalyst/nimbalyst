/**
 * Tiny ANSI color helper. Honors NO_COLOR, --no-color, and non-TTY stdout
 * (colors auto-off when piped), matching the plan's output rules.
 */
let enabled = computeDefault();

function computeDefault(): boolean {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') return false;
  return process.stdout.isTTY === true;
}

export function setColorEnabled(value: boolean): void {
  enabled = value;
}

export function colorEnabled(): boolean {
  return enabled;
}

const wrap = (open: number, close: number) => (s: string): string =>
  enabled ? `[${open}m${s}[${close}m` : s;

export const dim = wrap(2, 22);
export const bold = wrap(1, 22);
export const red = wrap(31, 39);
export const green = wrap(32, 39);
export const yellow = wrap(33, 39);
export const blue = wrap(34, 39);
export const cyan = wrap(36, 39);
export const gray = wrap(90, 39);

/** Color a status token by its lifecycle bucket. */
export function colorStatus(status: string | undefined): string {
  if (!status) return dim('—');
  const s = status.toLowerCase();
  if (['done', 'closed', 'completed', 'complete', 'resolved', 'merged'].includes(s)) return green(status);
  if (['rejected', 'cancelled', 'canceled', 'superseded', 'wontfix', "won't-fix"].includes(s)) return gray(status);
  if (['in-progress', 'in-review', 'in_review', 'review', 'doing'].includes(s)) return yellow(status);
  if (['blocked', 'failed'].includes(s)) return red(status);
  return cyan(status);
}
