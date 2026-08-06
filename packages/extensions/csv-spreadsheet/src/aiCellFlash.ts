export const CSV_AI_CELL_FLASH_EVENT = 'nimbalyst:csv-ai-cell-flash';
export const CSV_AI_CELL_FLASH_CHANNEL = 'nimbalyst-csv-ai-cell-flash';

export interface AICellFlashEventDetail {
  filePath: string;
  cells: readonly { row: number; column: number }[];
}

interface AICellFlashBroadcastMessage {
  sourceId: string;
  detail: AICellFlashEventDetail;
}

const sourceId = globalThis.crypto?.randomUUID?.()
  ?? `csv-flash-${Date.now()}-${Math.random().toString(36).slice(2)}`;
let broadcastChannel: BroadcastChannel | null | undefined;
const broadcastListeners = new Set<(detail: AICellFlashEventDetail) => void>();

function getBroadcastChannel(): BroadcastChannel | null {
  if (broadcastChannel !== undefined) return broadcastChannel;
  if (typeof window === 'undefined' || typeof window.BroadcastChannel === 'undefined') {
    broadcastChannel = null;
    return null;
  }
  broadcastChannel = new window.BroadcastChannel(CSV_AI_CELL_FLASH_CHANNEL);
  broadcastChannel.onmessage = (event: MessageEvent<AICellFlashBroadcastMessage>) => {
    if (!event.data || event.data.sourceId === sourceId) return;
    for (const listener of broadcastListeners) listener(event.data.detail);
  };
  return broadcastChannel;
}

export function subscribeSpreadsheetCellFlash(
  listener: (detail: AICellFlashEventDetail) => void,
): () => void {
  if (typeof window === 'undefined') return () => {};
  const handleLocalFlash = (event: Event) => {
    listener((event as CustomEvent<AICellFlashEventDetail>).detail);
  };
  broadcastListeners.add(listener);
  getBroadcastChannel();
  window.addEventListener(CSV_AI_CELL_FLASH_EVENT, handleLocalFlash);
  return () => {
    broadcastListeners.delete(listener);
    window.removeEventListener(CSV_AI_CELL_FLASH_EVENT, handleLocalFlash);
  };
}

export function notifySpreadsheetCellFlash(
  filePath: string | undefined,
  cells: readonly { row: number; column: number }[],
): void {
  if (!filePath || typeof window === 'undefined') return;
  const uniqueCells = [...new Map(cells.map((cell) => [`${cell.row}:${cell.column}`, cell])).values()];
  if (uniqueCells.length === 0) return;
  const detail = { filePath, cells: uniqueCells } satisfies AICellFlashEventDetail;
  window.dispatchEvent(new CustomEvent<AICellFlashEventDetail>(CSV_AI_CELL_FLASH_EVENT, { detail }));
  getBroadcastChannel()?.postMessage({ sourceId, detail } satisfies AICellFlashBroadcastMessage);
}
