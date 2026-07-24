/**
 * Interactive prompts for AIInput
 *
 * This module contains specialized prompt modes that can be activated
 * in the AI input field based on specific triggers or commands.
 */

export {
  MemoryPromptIndicator,
  MemorySaveButton,
  useMemoryMode,
  shouldActivateMemoryMode,
  getMemoryContent,
  type MemoryTarget,
} from './MemoryPrompt';
