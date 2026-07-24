/**
 * Error Test Extension
 *
 * This extension is for testing the error handling and error console.
 * It provides AI tools that deliberately trigger various error conditions.
 */

import type { ExtensionAITool, AIToolContext, ExtensionToolResult } from '@nimbalyst/extension-sdk';

/**
 * Tool that throws an error - tests error propagation
 */
const triggerErrorTool: ExtensionAITool = {
  name: 'trigger_error',
  description: 'Deliberately throws an error for testing error handling. Use this to test the extension error console.',

  inputSchema: {
    type: 'object',
    properties: {
      errorType: {
        type: 'string',
        description: 'Type of error to trigger: "sync" (synchronous throw), "async" (rejected promise), "undefined" (access undefined property)',
        enum: ['sync', 'async', 'undefined'],
      },
      message: {
        type: 'string',
        description: 'Custom error message',
      },
    },
    required: ['errorType'],
  },
  handler: async (args, context): Promise<ExtensionToolResult> => {
    const { errorType, message } = args as { errorType: string; message?: string };
    const errorMessage = message || `Test error from error-test extension (type: ${errorType})`;

    console.log(`[error-test] About to trigger ${errorType} error...`);

    switch (errorType) {
      case 'sync':
        throw new Error(errorMessage);

      case 'async':
        return Promise.reject(new Error(errorMessage));

      case 'undefined':
        // Deliberately access undefined property
        const obj: any = undefined;
        return obj.nonExistentProperty.anotherLevel;

      default:
        return {
          success: false,
          error: `Unknown error type: ${errorType}`,
        };
    }
  },
};

/**
 * Tool that logs warnings - tests warning visibility
 */
const triggerWarningTool: ExtensionAITool = {
  name: 'trigger_warning',
  description: 'Logs warnings and info messages to test the extension log console filtering.',

  inputSchema: {
    type: 'object',
    properties: {
      count: {
        type: 'number',
        description: 'Number of log messages to generate (default: 5)',
      },
    },
  },
  handler: async (args, context): Promise<ExtensionToolResult> => {
    const count = (args.count as number) || 5;

    console.log(`[error-test] Generating ${count} log messages...`);

    for (let i = 1; i <= count; i++) {
      if (i % 3 === 0) {
        console.error(`[error-test] Test error message ${i}/${count}`);
      } else if (i % 2 === 0) {
        console.warn(`[error-test] Test warning message ${i}/${count}`);
      } else {
        console.info(`[error-test] Test info message ${i}/${count}`);
      }
    }

    return {
      success: true,
      message: `Generated ${count} log messages (check the extension error console)`,
      data: {
        errors: Math.floor(count / 3),
        warnings: Math.floor(count / 2) - Math.floor(count / 6),
        info: count - Math.floor(count / 2),
      },
    };
  },
};

/**
 * Tool that simulates a timeout - tests timeout handling
 */
const triggerTimeoutTool: ExtensionAITool = {
  name: 'trigger_timeout',
  description: 'Simulates a long-running operation that may timeout. Use to test timeout error messages.',

  inputSchema: {
    type: 'object',
    properties: {
      delaySeconds: {
        type: 'number',
        description: 'How many seconds to wait before returning (default: 5, use >30 to trigger timeout)',
      },
    },
  },
  handler: async (args, context): Promise<ExtensionToolResult> => {
    const delaySeconds = (args.delaySeconds as number) || 5;
    const delayMs = delaySeconds * 1000;

    console.log(`[error-test] Starting ${delaySeconds}s delay...`);

    await new Promise((resolve) => setTimeout(resolve, delayMs));

    console.log(`[error-test] Delay complete!`);

    return {
      success: true,
      message: `Successfully waited ${delaySeconds} seconds`,
    };
  },
};

// Export the AI tools
export const aiTools = [triggerErrorTool, triggerWarningTool, triggerTimeoutTool];

// Activation hook
export function activate() {
  console.log('[error-test] Error Test Extension activated!');
  console.warn('[error-test] This is a test warning from activation');
}

export function deactivate() {
  console.log('[error-test] Error Test Extension deactivated');
}
