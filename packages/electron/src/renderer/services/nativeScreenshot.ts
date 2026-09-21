/** Shared pixel capture for visible editors and the host's offscreen renderer. */
export interface CaptureRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function visibleCaptureRect(element: HTMLElement): CaptureRect {
  if (!element.isConnected || element.ownerDocument !== document) {
    throw new Error('Screenshot target must be mounted in this window.');
  }
  const bounds = element.getBoundingClientRect();
  let left = Math.max(0, bounds.left),
    top = Math.max(0, bounds.top);
  let right = Math.min(innerWidth, bounds.right),
    bottom = Math.min(innerHeight, bounds.bottom);
  for (
    let node: HTMLElement | null = element;
    node;
    node = node.parentElement
  ) {
    const style = getComputedStyle(node);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.opacity === '0'
    ) {
      throw new Error(
        'Screenshot target is hidden. Use file capture for a hidden editor.'
      );
    }
    if (node === element) continue;
    const clip = node.getBoundingClientRect();
    if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
      left = Math.max(left, clip.left);
      right = Math.min(right, clip.right);
    }
    if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
      top = Math.max(top, clip.top);
      bottom = Math.min(bottom, clip.bottom);
    }
  }
  const x = Math.ceil(left),
    y = Math.ceil(top);
  const width = Math.floor(right) - x,
    height = Math.floor(bottom) - y;
  if (width <= 0 || height <= 0)
    throw new Error('Screenshot target has no visible area.');
  return { x, y, width, height };
}

export async function captureNativeRect(rect: CaptureRect): Promise<string> {
  if (
    !Object.values(rect).every(Number.isFinite) ||
    rect.width <= 0 ||
    rect.height <= 0
  ) {
    throw new Error('Screenshot has invalid dimensions.');
  }
  const result = await window.electronAPI.invoke(
    'offscreen-editor:native-capture',
    { rect }
  );
  if (!result?.success || !result.imageBase64)
    throw new Error(result?.error || 'Native screenshot failed.');
  return result.imageBase64;
}

export function captureNativeElement(element: HTMLElement): Promise<string> {
  return captureNativeRect(visibleCaptureRect(element));
}
