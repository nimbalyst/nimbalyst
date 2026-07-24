/**
 * Service for loading custom tracker definitions from workspace .nimbalyst/trackers directory
 */

import { logger } from '../utils/logger';

const log = logger.general;

/**
 * Loads custom tracker YAML definitions from the workspace's .nimbalyst/trackers directory
 * @param workspacePath - Path to the workspace root
 */
export async function loadCustomTrackers(workspacePath: string): Promise<void> {
  if (!workspacePath || !window.electronAPI?.getFolderContents || !window.electronAPI?.readFileContent) {
    return;
  }

  try {
    const { globalRegistry, parseTrackerYAML } = await import('@nimbalyst/runtime');

    // Use simple path joining (works in browser)
    const trackersDir = `${workspacePath}/.nimbalyst/trackers`;
    // log.info('[CustomTrackers] Loading from:', trackersDir);

    // Try reading known tracker files directly instead of listing directory
    // This avoids file tree caching issues
    const knownTrackerFiles = ['character.yaml', 'recipe.yaml', 'research-paper.yaml'];

    for (const fileName of knownTrackerFiles) {
      try {
        const filePath = `${trackersDir}/${fileName}`;
        const result = await window.electronAPI.readFileContent(filePath);

        if (result && result.success) {
          const model = parseTrackerYAML(result.content);
          globalRegistry.register(model);
          // log.info(`[CustomTrackers] Registered: ${model.type} (${model.displayName})`);
        }
      } catch (error) {
        // File doesn't exist, skip silently
      }
    }

    // Also scan directory for any other YAML files
    try {
      const files = await window.electronAPI.getFolderContents(trackersDir);
      const yamlFiles = files.filter(f =>
        f.type === 'file' &&
        (f.name.endsWith('.yaml') || f.name.endsWith('.yml')) &&
        !knownTrackerFiles.includes(f.name)
      );

      for (const file of yamlFiles) {
        try {
          const filePath = `${trackersDir}/${file.name}`;
          const result = await window.electronAPI.readFileContent(filePath);

          if (result && result.success && result.content) {
            const model = parseTrackerYAML(result.content);
            globalRegistry.register(model);
            // log.info(`[CustomTrackers] Registered: ${model.type} (${model.displayName})`);
          }
        } catch (error) {
          log.error(`[CustomTrackers] Failed to load ${file.name}:`, error);
        }
      }
    } catch (error) {
      log.info('[CustomTrackers] Could not scan directory, relying on known files');
    }
  } catch (error) {
    log.error('[CustomTrackers] Failed to load custom trackers:', error);
  }
}
