import { useSyncExternalStore } from 'react';
import {
  getRegisteredTranscriptToolNames,
  subscribeToTranscriptToolWidgets,
} from './TranscriptToolWidgetContributions';

/**
 * Re-render whenever the transcript tool widget registry changes. Callers
 * resolve specific tool names with `getTranscriptToolWidget`; this hook
 * just keeps them subscribed so a registry change after mount (e.g. a new
 * extension enabling) reflows the transcript.
 */
export function useTranscriptToolWidgetRegistryVersion(): readonly string[] {
  return useSyncExternalStore(
    subscribeToTranscriptToolWidgets,
    getRegisteredTranscriptToolNames,
    getRegisteredTranscriptToolNames,
  );
}
