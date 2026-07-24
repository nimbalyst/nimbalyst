# Project Overview

This is a sample document with various markdown elements.

## Introduction

The goal of this project is to demonstrate the diff algorithm's ability to handle appended content without marking existing content as modified.

### Key Features

- Feature one: Basic text handling
- Feature two: Complex markdown structures
- Feature three: Proper change detection

## Technical Details

Here's a code example showing the implementation:

```javascript
function processContent(input) {
  return input.trim().toLowerCase();
}
```

The function above handles basic text processing.

## Data Structure

| Column A | Column B | Column C |
|----------|----------|----------|
| Value 1  | Value 2  | Value 3  |
| Value 4  | Value 5  | Value 6  |

This table shows the data layout.

## Summary

In conclusion, this document contains multiple content types to test the diff algorithm's accuracy when new content is appended.

## Additional Section

This is new content appended to the end of the document.

### New Subsection

- New item 1
- New item 2
- New item 3

The diff algorithm should mark only this section as added, without modifying any of the existing content above.
