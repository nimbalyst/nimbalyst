import type { ExtensionContext, ExtensionAITool, AIToolContext, ToolResult } from '@nimbalyst/extension-sdk';

/**
 * iOS Development Tools Extension
 *
 * Provides AI tools and commands to assist with iOS development workflows.
 * These tools provide guidance and command templates that Claude can execute
 * using the Bash tool.
 */

// Helper: Create instruction-based tool results
function bashInstruction(command: string, description: string): ToolResult {
  return {
    content: [
      {
        type: 'text',
        text: `${description}\n\nExecute this command:\n\`\`\`bash\n${command}\n\`\`\``,
      },
    ],
  };
}

// XcodeGen Tools
const xcodeGenTool: ExtensionAITool = {
  name: 'ios-dev.xcodegen',
  description: 'Get commands for working with XcodeGen (project.yml management). Actions: check-install, validate, generate, or get-template.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'Action: check-install, validate, generate, or get-template',
        enum: ['check-install', 'validate', 'generate', 'get-template'],
      },
      projectPath: {
        type: 'string',
        description: 'Path to directory containing project.yml (default: current directory)',
      },
    },
    required: ['action'],
  },
  handler: async (args: Record<string, unknown>, _context: AIToolContext): Promise<any> => {
    const action = args.action as string;
    const projectPath = (args.projectPath as string) || '.';

    switch (action) {
      case 'check-install':
        return bashInstruction(
          'which xcodegen || echo "Not installed. Run: brew install xcodegen"',
          'Check if XcodeGen is installed:'
        );

      case 'validate':
        return bashInstruction(
          `cd "${projectPath}" && xcodegen generate --spec project.yml`,
          'Validate project.yml (will show errors if invalid):'
        );

      case 'generate':
        return bashInstruction(
          `cd "${projectPath}" && xcodegen generate`,
          'Generate Xcode project from project.yml:'
        );

      case 'get-template':
        return {
          content: [
            {
              type: 'text',
              text: `Basic XcodeGen project.yml template:

\`\`\`yaml
name: MyApp
options:
  bundleIdPrefix: com.example
  deploymentTarget:
    iOS: "15.0"

targets:
  MyApp:
    type: application
    platform: iOS
    sources:
      - Sources
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: com.example.MyApp
        INFOPLIST_FILE: Sources/Info.plist

schemes:
  MyApp:
    build:
      targets:
        MyApp: all
    run:
      config: Debug
    archive:
      config: Release
\`\`\`

After creating this file:
1. Create the Sources directory
2. Add your Swift files to Sources/
3. Run \`xcodegen generate\``,
            },
          ],
        };

      default:
        return {
          content: [
            {
              type: 'text',
              text: 'Invalid action. Use: check-install, validate, generate, or get-template',
            },
          ],
        };
    }
  },
};

// Simulator Tools
const simulatorTool: ExtensionAITool = {
  name: 'ios-dev.simulator',
  description: 'Get commands for iOS Simulator management. Actions: list, boot, or shutdown.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'Action: list, boot, or shutdown',
        enum: ['list', 'boot', 'shutdown'],
      },
      deviceId: {
        type: 'string',
        description: 'Device UDID or name (for boot/shutdown actions)',
      },
    },
    required: ['action'],
  },
  handler: async (args: Record<string, unknown>, _context: AIToolContext): Promise<any> => {
    const action = args.action as string;
    const deviceId = args.deviceId as string;

    switch (action) {
      case 'list':
        return bashInstruction(
          'xcrun simctl list devices available',
          'List all available iOS simulators:'
        );

      case 'boot':
        if (!deviceId) {
          return {
            content: [
              {
                type: 'text',
                text: 'Error: deviceId required for boot action. First run list action to see available simulators.',
              },
            ],
          };
        }
        return bashInstruction(
          `xcrun simctl boot "${deviceId}" && open -a Simulator`,
          `Boot simulator ${deviceId}:`
        );

      case 'shutdown':
        if (!deviceId) {
          return bashInstruction(
            'xcrun simctl shutdown all',
            'Shutdown all running simulators:'
          );
        }
        return bashInstruction(
          `xcrun simctl shutdown "${deviceId}"`,
          `Shutdown simulator ${deviceId}:`
        );

      default:
        return {
          content: [
            {
              type: 'text',
              text: 'Invalid action. Use: list, boot, or shutdown',
            },
          ],
        };
    }
  },
};

// Build Tool
const buildTool: ExtensionAITool = {
  name: 'ios-dev.build',
  description: 'Get commands for building iOS apps. Actions: schemes, build, or clean.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'Action: schemes, build, or clean',
        enum: ['schemes', 'build', 'clean'],
      },
      projectPath: {
        type: 'string',
        description: 'Path to Xcode project directory',
      },
      scheme: {
        type: 'string',
        description: 'Build scheme name (for build action)',
      },
      configuration: {
        type: 'string',
        description: 'Build configuration: Debug or Release (default: Debug)',
        enum: ['Debug', 'Release'],
      },
      destination: {
        type: 'string',
        description: 'Build destination (default: iPhone 15 Pro simulator)',
      },
    },
    required: ['action'],
  },
  handler: async (args: Record<string, unknown>, _context: AIToolContext): Promise<any> => {
    const action = args.action as string;
    const projectPath = (args.projectPath as string) || '.';
    const scheme = args.scheme as string;
    const configuration = (args.configuration as string) || 'Debug';
    const destination = (args.destination as string) || 'platform=iOS Simulator,name=iPhone 15 Pro';

    switch (action) {
      case 'schemes':
        return bashInstruction(
          `cd "${projectPath}" && xcodebuild -list`,
          'List available schemes and configurations:'
        );

      case 'build':
        if (!scheme) {
          return {
            content: [
              {
                type: 'text',
                text: 'Error: scheme required for build action. First run schemes action to see available schemes.',
              },
            ],
          };
        }
        return bashInstruction(
          `cd "${projectPath}" && xcodebuild -scheme "${scheme}" -configuration ${configuration} -destination "${destination}" build`,
          `Build ${scheme} (${configuration}):`
        );

      case 'clean':
        return bashInstruction(
          `cd "${projectPath}" && xcodebuild clean`,
          'Clean build artifacts:'
        );

      default:
        return {
          content: [
            {
              type: 'text',
              text: 'Invalid action. Use: schemes, build, or clean',
            },
          ],
        };
    }
  },
};

// Install and Launch Tools
const appManagementTool: ExtensionAITool = {
  name: 'ios-dev.app',
  description: 'Get commands for installing and launching apps on simulators. Actions: install, launch, or logs.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'Action: install, launch, or logs',
        enum: ['install', 'launch', 'logs'],
      },
      deviceId: {
        type: 'string',
        description: 'Simulator UDID (required for install/launch)',
      },
      appPath: {
        type: 'string',
        description: 'Path to .app bundle (for install action)',
      },
      bundleId: {
        type: 'string',
        description: 'App bundle identifier (for launch action)',
      },
    },
    required: ['action'],
  },
  handler: async (args: Record<string, unknown>, _context: AIToolContext): Promise<any> => {
    const action = args.action as string;
    const deviceId = args.deviceId as string;
    const appPath = args.appPath as string;
    const bundleId = args.bundleId as string;

    switch (action) {
      case 'install':
        if (!deviceId || !appPath) {
          return {
            content: [
              {
                type: 'text',
                text: 'Error: deviceId and appPath required for install action.',
              },
            ],
          };
        }
        return bashInstruction(
          `xcrun simctl install "${deviceId}" "${appPath}"`,
          `Install app on simulator ${deviceId}:`
        );

      case 'launch':
        if (!deviceId || !bundleId) {
          return {
            content: [
              {
                type: 'text',
                text: 'Error: deviceId and bundleId required for launch action.',
              },
            ],
          };
        }
        return bashInstruction(
          `xcrun simctl launch "${deviceId}" "${bundleId}"`,
          `Launch app ${bundleId} on simulator:`
        );

      case 'logs':
        if (!deviceId) {
          return bashInstruction(
            'xcrun simctl spawn booted log stream --level debug',
            'Stream logs from booted simulator:'
          );
        }
        return bashInstruction(
          `xcrun simctl spawn "${deviceId}" log stream --level debug`,
          `Stream logs from simulator ${deviceId}:`
        );

      default:
        return {
          content: [
            {
              type: 'text',
              text: 'Invalid action. Use: install, launch, or logs',
            },
          ],
        };
    }
  },
};

// Export AI tools for manifest validation and static registration
export const aiTools: ExtensionAITool[] = [
  xcodeGenTool,
  simulatorTool,
  buildTool,
  appManagementTool,
];

export function activate(context: ExtensionContext) {
  // Register all AI tools via the AI service
  for (const tool of aiTools) {
    context.subscriptions.push(context.services.ai!.registerTool(tool));
  }

  console.log('iOS Development Tools extension activated');
}

export function deactivate() {
  console.log('iOS Development Tools extension deactivated');
}
