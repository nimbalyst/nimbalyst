export function reportResolvedTitleBarColors(
  root: HTMLElement = document.documentElement,
): void {
  const styles = getComputedStyle(root);
  const color = styles.getPropertyValue('--nim-bg-secondary').trim();
  const symbolColor = styles.getPropertyValue('--nim-text').trim();
  if (!color || !symbolColor) return;

  window.electronAPI?.setTitleBarOverlayColors?.({ color, symbolColor });
}
