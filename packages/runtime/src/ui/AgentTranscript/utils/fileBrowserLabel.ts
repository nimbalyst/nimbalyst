export function getShowInFileBrowserLabel(
  platform = typeof navigator !== 'undefined' ? navigator.platform : '',
): string {
  if (platform.startsWith('Mac')) return 'Show in Finder';
  if (platform.startsWith('Win')) return 'Show in Explorer';
  return 'Show in Folder';
}
