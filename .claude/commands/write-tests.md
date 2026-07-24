---
packageVersion: 1.0.0
packageId: developer
description: Generate comprehensive test coverage for existing code.
---

# /write-tests Command

Generate comprehensive test coverage for existing code.

## What This Command Does

1. Analyzes code to test
2. Identifies test cases (happy path, edge cases, errors)
3. Generates test code in appropriate framework
4. Includes setup/teardown as needed

## Usage

`/write-tests [file or function]`

## Test Generation Approach

- Uses existing test framework in project
- Follows project test patterns
- Includes meaningful test names
- Covers edge cases and error conditions
- Adds necessary mocks/fixtures

## Best Practices

- Review generated tests for accuracy
- Adjust assertions as needed
- Run tests to verify they pass
- Add tests incrementally for large files
