/**
 * Typed access to the crew backend's panel-only tools. The panel never talks
 * to IPC directly; everything goes through `host.callBackendTool`, which the
 * host restricts to this extension's own backend module.
 */
import type { PanelHost } from '@nimbalyst/extension-sdk';
import { crewPanelToolName, type CrewPanelToolKey, type CrewPanelToolMap } from '../shared/types';

export interface CrewClient {
  call<K extends CrewPanelToolKey>(key: K, request: CrewPanelToolMap[K][0]): Promise<CrewPanelToolMap[K][1]>;
}

export function createCrewClient(host: Pick<PanelHost, 'callBackendTool'>): CrewClient {
  return {
    async call(key, request) {
      const result = await host.callBackendTool(crewPanelToolName(key), request as Record<string, unknown>);
      return result as never;
    },
  };
}
