/**
 * Typed access to the Run Manager backend's panel-only tools. The panel never
 * talks to IPC directly; everything goes through `host.callBackendTool`, which
 * the host restricts to this extension's own backend module.
 */
import type { PanelHost } from '@nimbalyst/extension-sdk';
import { runPanelToolName, type RunPanelToolKey, type RunPanelToolMap } from '../shared/types';

export interface RunsClient {
  call<K extends RunPanelToolKey>(key: K, request: RunPanelToolMap[K][0]): Promise<RunPanelToolMap[K][1]>;
}

export function createRunsClient(host: Pick<PanelHost, 'callBackendTool'>): RunsClient {
  return {
    async call(key, request) {
      const result = await host.callBackendTool(runPanelToolName(key), request as Record<string, unknown>);
      return result as never;
    },
  };
}
