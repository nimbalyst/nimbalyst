import { safeHandle } from '../utils/ipcRegistry';
import { OpenCodeConfigService, LMStudioBridgeOptions } from '../services/OpenCodeConfigService';
import type { OpenCodeFileConfig } from '@nimbalyst/runtime/ai/server';
import { logger } from '../utils/logger';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

const service = new OpenCodeConfigService();

export function getOpenCodeConfigService(): OpenCodeConfigService {
  return service;
}

/**
 * Fetch the list of locally-loaded models from an LM Studio server.
 * LM Studio exposes an OpenAI-compatible `/v1/models` endpoint.
 */
async function fetchLMStudioModels(baseUrl: string): Promise<string[]> {
  const root = baseUrl.replace(/\/+$/, '').replace(/\/v\d+$/, '');
  const url = `${root}/v1/models`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`LM Studio returned ${response.status} from ${url}`);
  }
  const payload = await response.json() as { data?: Array<{ id?: string }> };
  return (payload.data ?? [])
    .map((entry) => entry.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

export function registerOpenCodeConfigHandlers(): void {
  safeHandle('opencode-config:read', async () => {
    try {
      const config = await service.readConfig();
      return { success: true, config, configPath: service.getConfigPath() };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.ai.error('[OpenCode] Failed to read config:', error);
      return { success: false, error: message };
    }
  });

  safeHandle('opencode-config:merge', async (_event, patch: Partial<OpenCodeFileConfig>) => {
    if (!patch || typeof patch !== 'object') {
      throw new Error('opencode-config:merge requires a patch object');
    }
    try {
      const config = await service.mergeConfig(patch);
      return { success: true, config };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.ai.error('[OpenCode] Failed to merge config:', error);
      return { success: false, error: message };
    }
  });

  safeHandle('opencode-config:upsert-lmstudio', async (_event, options: LMStudioBridgeOptions & { autoDiscoverModels?: boolean }) => {
    if (!options?.baseUrl) {
      throw new Error('opencode-config:upsert-lmstudio requires baseUrl');
    }
    try {
      let modelIds = Array.isArray(options.modelIds) ? options.modelIds.filter(Boolean) : [];
      if ((options.autoDiscoverModels ?? true) && modelIds.length === 0) {
        modelIds = await fetchLMStudioModels(options.baseUrl);
      }
      if (modelIds.length === 0) {
        return {
          success: false,
          error: 'No models discovered from LM Studio. Make sure a model is loaded.',
        };
      }
      const config = await service.upsertLMStudioBridge({
        baseUrl: options.baseUrl,
        modelIds,
        displayName: options.displayName,
      });
      return { success: true, config, modelIds };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.ai.error('[OpenCode] Failed to upsert LM Studio bridge:', error);
      return { success: false, error: message };
    }
  });

  safeHandle('opencode-config:remove-lmstudio', async () => {
    try {
      const config = await service.removeLMStudioBridge();
      return { success: true, config };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.ai.error('[OpenCode] Failed to remove LM Studio bridge:', error);
      return { success: false, error: message };
    }
  });

  safeHandle('opencode-config:list-agents', async () => {
    try {
      // OpenCode uses XDG_CONFIG_HOME (~/.config) on all platforms including Windows
      const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
      const agentDir = path.join(xdgConfig, 'opencode', 'agent');

      if (!fs.existsSync(agentDir)) {
        return { success: true, agents: [] };
      }

      const files = fs.readdirSync(agentDir);
      const agents = files
        .filter(f => f.endsWith('.md'))
        .map(f => path.basename(f, '.md'));

      return { success: true, agents };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.ai.warn('[OpenCode] Failed to list agents:', message);
      return { success: true, agents: [] };
    }
  });
}
