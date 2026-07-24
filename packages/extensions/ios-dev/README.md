# iOS Development Tools Extension

Tools for iOS development including XcodeGen project generation, simulator management, and app building/deployment.

## Features

### AI Tools

The extension provides the following tools that Claude can use:

**XcodeGen:**
- `ios-dev.validate-project-yml` - Validate XcodeGen configuration
- `ios-dev.generate-xcode-project` - Generate Xcode project from YAML

**Simulator Management:**
- `ios-dev.list-simulators` - List available iOS simulators
- `ios-dev.launch-simulator` - Launch a specific simulator
- `ios-dev.get-simulator-logs` - Retrieve simulator console logs

**Building & Deployment:**
- `ios-dev.build-app` - Build iOS app with xcodebuild
- `ios-dev.install-app` - Install app on simulator
- `ios-dev.launch-app` - Launch installed app
- `ios-dev.get-simulator-logs` - View app console output

### Claude Commands

**`/xcodegen`** - Generate and manage Xcode projects with XcodeGen
- Create new project.yml configurations
- Modify existing project specifications
- Validate and generate Xcode projects

**`/ios-simulator`** - Launch and manage iOS simulators
- List available simulators
- Launch specific devices
- View simulator logs

**`/ios-build`** - Build and deploy iOS apps
- Build for simulator or device
- Install on simulators
- Launch and debug apps

### File Type Support

Custom icons for iOS file types:
- `.swift` - Swift source files
- `.xcodeproj` - Xcode projects
- `.xcworkspace` - Xcode workspaces
- `.storyboard` - Interface Builder storyboards
- `.xib` - Interface Builder XIB files
- `.xcassets` - Asset catalogs
- `project.yml` - XcodeGen configuration

### New File Menu

Quick creation of Swift files with basic template.

## Prerequisites

**Required:**
- Xcode Command Line Tools: `xcode-select --install`
- macOS (iOS development requires Mac)

**Optional:**
- XcodeGen: `brew install xcodegen` (for project generation features)

## Installation

1. Build the extension:
```bash
cd packages/extensions/ios-dev
npm install
npm run build
```

2. The extension will be automatically loaded by Nimbalyst.

## Development

Watch mode for development:
```bash
npm run dev
```

## Usage Examples

### Creating a New iOS Project with XcodeGen

1. Run `/xcodegen` command
2. Claude will guide you through creating a project.yml
3. The Xcode project will be generated automatically

### Building and Running on Simulator

1. Run `/ios-build` command
2. Claude will help you:
  - Select a simulator
  - Build the app
  - Install and launch it

### Debugging with Simulator Logs

1. Run `/ios-simulator` command
2. Ask to view logs for a specific simulator
3. Claude will retrieve recent console output

## Architecture

The extension uses:
- **AI Tools** for direct Xcode/simulator interaction
- **Claude Commands** for guided workflows
- **File Icons** for better visual organization

All tools execute shell commands via Node.js `child_process.execSync()` to interact with Xcode command-line tools.

## License

MIT
