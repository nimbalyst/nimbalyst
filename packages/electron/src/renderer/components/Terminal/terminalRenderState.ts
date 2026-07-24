export function canPersistTerminalRenderState(
  hasTerminal: boolean,
  disposed: boolean,
  restoreComplete: boolean,
): boolean {
  return hasTerminal && !disposed && restoreComplete;
}
