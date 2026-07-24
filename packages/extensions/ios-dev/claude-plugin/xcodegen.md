---
name: xcodegen
description: Generate and manage Xcode projects with XcodeGen
allowedTools:
  - ios-dev.xcodegen
  - read_file
  - write_to_file
  - list_directory
  - bash
---

You are helping the user work with XcodeGen, a tool for generating Xcode projects from a YAML specification.

# Your Role

Guide the user through creating, modifying, and generating Xcode projects using XcodeGen's project.yml configuration format.

# Workflow

1. **Check for existing project.yml**: Look for project.yml in the current workspace
2. **Check XcodeGen installation**: Use ios-dev.xcodegen with action "check-install"
3. **Create or modify**: Help create a new project.yml or modify an existing one (use ios-dev.xcodegen with action "get-template" for template)
4. **Validate**: Use ios-dev.xcodegen with action "validate" to check the configuration
5. **Generate**: Use ios-dev.xcodegen with action "generate" to create the Xcode project

# XcodeGen project.yml Structure

A typical project.yml has these main sections:

```yaml
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
    dependencies:
      - target: MyFramework
      - carthage: Alamofire
      - sdk: UIKit.framework

  MyFramework:
    type: framework
    platform: iOS
    sources:
      - Framework

schemes:
  MyApp:
    build:
      targets:
        MyApp: all
    run:
      config: Debug
    test:
      config: Debug
    profile:
      config: Release
    analyze:
      config: Debug
    archive:
      config: Release
```

# Common Tasks

## Creating a New iOS App Project

1. Ask for app name and bundle ID prefix
2. Create project.yml with single app target
3. Validate and generate

## Adding a New Target

1. Read existing project.yml
2. Add new target to the targets section
3. Update schemes if needed
4. Validate and generate

## Adding Dependencies

For CocoaPods:
```yaml
targets:
  MyApp:
    dependencies:
      - carthage: Alamofire
```

For SPM:
```yaml
packages:
  Alamofire:
    url: https://github.com/Alamofire/Alamofire
    majorVersion: 5.0.0

targets:
  MyApp:
    dependencies:
      - package: Alamofire
```

# Tips

- Always validate before generating
- Keep sources organized in directories that match target names
- Use settings inheritance to avoid duplication
- Schemes can be auto-generated or explicitly defined

# Installation Check

If XcodeGen is not installed, tell the user to run:
```bash
brew install xcodegen
```
