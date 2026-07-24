/**
 * Set up the mockup platform service implementation, then publish the
 * mockup Lexical extension + slash-picker entry into the runtime
 * extension stores.
 */

import {
  INSERT_MOCKUP_COMMAND,
  MOCKUP_TRANSFORMER,
  MockupLexicalExtension,
  setExtensionContributions,
  setExtensionLexicalExtension,
  setMockupPlatformService,
} from '@nimbalyst/runtime';
import { MockupPlatformServiceImpl } from '../services/MockupPlatformServiceImpl';
import { showMockupPickerMenu } from '../components/MockupPickerMenu';

const SOURCE = 'mockup';

export function registerMockupPlugin(): void {
  const service = MockupPlatformServiceImpl.getInstance();
  service.showMockupPicker = showMockupPickerMenu;
  setMockupPlatformService(service);

  setExtensionLexicalExtension(SOURCE, MockupLexicalExtension);
  setExtensionContributions(SOURCE, {
    markdownTransformers: [MOCKUP_TRANSFORMER],
    userCommands: [
      {
        title: 'Mockup',
        description: 'Insert a mockup',
        icon: 'design_services',
        keywords: ['mockup', 'design', 'prototype', 'ui', 'layout'],
        command: INSERT_MOCKUP_COMMAND,
      },
    ],
  });
}
