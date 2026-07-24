/**
 * MockupPlugin - exports the node, transformer, command, and a Lexical
 * extension that registers `MockupNode` and the `INSERT_MOCKUP_COMMAND`
 * handler. There is no React component because the plugin has no UI
 * concerns of its own; the renderer-side `registerMockupPlugin` publishes
 * this extension into the Lexical extension store and contributes the
 * slash-picker entry via the contributions store.
 */

import type { LexicalCommand } from 'lexical';

import {
  $insertNodes,
  COMMAND_PRIORITY_EDITOR,
  createCommand,
  defineExtension,
} from 'lexical';

import {
  getMockupPlatformService,
  hasMockupPlatformService,
} from './MockupPlatformService';
import { $createMockupNode, MockupNode, MockupPayload } from './MockupNode';
import { MOCKUP_TRANSFORMER } from './MockupTransformer';

export { MockupNode, $createMockupNode, $isMockupNode } from './MockupNode';
export type { MockupPayload, SerializedMockupNode } from './MockupNode';
export { MOCKUP_TRANSFORMER } from './MockupTransformer';
export type { MockupPlatformService } from './MockupPlatformService';
export {
  setMockupPlatformService,
  getMockupPlatformService,
  hasMockupPlatformService,
} from './MockupPlatformService';

/**
 * Command to insert a mockup into the editor.
 * If called with payload (mockupPath + screenshotPath), inserts directly.
 * If called without payload, shows the mockup picker UI.
 */
export const INSERT_MOCKUP_COMMAND: LexicalCommand<MockupPayload | undefined> =
  createCommand('INSERT_MOCKUP_COMMAND');

/**
 * Generates a screenshot for a mockup and returns the paths.
 * Uses the platform service to capture the screenshot.
 *
 * @param mockupPath - Absolute path to the mockup file
 * @param documentPath - Absolute path to the document (for determining assets folder)
 * @returns Object with screenshotPath (relative) and absoluteScreenshotPath
 */
export async function generateMockupScreenshot(
  mockupPath: string,
  documentPath: string,
): Promise<{ screenshotPath: string; absoluteScreenshotPath: string }> {
  if (!hasMockupPlatformService()) {
    throw new Error('MockupPlatformService not available');
  }

  const service = getMockupPlatformService();

  const mockupFilename =
    mockupPath.split('/').pop()?.replace('.mockup.html', '') || 'mockup';

  const documentDir = documentPath.substring(0, documentPath.lastIndexOf('/'));
  const assetsDir = `${documentDir}/assets`;
  const screenshotFilename = `${mockupFilename}.mockup.png`;
  const absoluteScreenshotPath = `${assetsDir}/${screenshotFilename}`;

  await service.captureScreenshot(mockupPath, absoluteScreenshotPath);

  const screenshotPath = `assets/${screenshotFilename}`;
  return { screenshotPath, absoluteScreenshotPath };
}

/**
 * Lexical extension that registers `MockupNode` and the
 * `INSERT_MOCKUP_COMMAND` handler. Pass to `setExtensionLexicalExtension`
 * from the platform-side registrar.
 */
export const MockupLexicalExtension = defineExtension({
  name: '@nimbalyst/mockup',
  nodes: [MockupNode],
  register: (editor) =>
    editor.registerCommand<MockupPayload | undefined>(
      INSERT_MOCKUP_COMMAND,
      (payload) => {
        if (payload?.mockupPath) {
          const mockupNode = $createMockupNode({
            ...payload,
            screenshotPath: payload.screenshotPath || '',
          });
          $insertNodes([mockupNode]);
          return true;
        }
        if (hasMockupPlatformService()) {
          const service = getMockupPlatformService();
          service.showMockupPicker();
        } else {
          console.warn('[MockupExtension] Platform service not available');
        }
        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    ),
});
