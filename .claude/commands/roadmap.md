---
packageVersion: 1.0.0
packageId: product-manager
description: Generate a product roadmap from plans and feature requests.
---

# /roadmap Command

Generate a product roadmap view from existing plans and feature requests.

## What This Command Does

1. Scans all plan documents
2. Groups by quarter or timeframe
3. Organizes by priority and dependencies
4. Creates visual roadmap document

## Usage

`/roadmap [timeframe]`

**Timeframes:**
- `quarter`: Group by quarter (Q1, Q2, Q3, Q4)
- `month`: Group by month
- `year`: Annual view

## Output

Creates a roadmap document with:
- Timeline visualization
- Features grouped by timeframe
- Priority indicators
- Status of each initiative
- Dependencies highlighted

## Best Practices

- Update plan statuses before generating roadmap
- Review with stakeholders regularly
- Keep roadmap in sync with actual progress
