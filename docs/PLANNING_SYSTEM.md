# Nimbalyst Planning System

## Overview

Nimbalyst includes a comprehensive markdown-based planning system that enables developers and AI coding agents to collaboratively manage development workstreams. The system uses structured markdown files with YAML frontmatter to track features, bugs, refactors, and other development tasks.

## Philosophy

The planning system is designed around these core principles:

1. **Single Source of Truth**: Plan documents are the authoritative record for development work
2. **Human-AI Collaboration**: Plans support both human editing and AI agent updates
3. **Real-Time Integration**: Plan metadata is automatically cached and surfaced throughout the UI
4. **Agentic Coding**: Plans can launch and track AI coding sessions for implementation

## Document Location and Structure

### Storage Location

All plan documents are stored in the `plans/` directory at the root of your workspace. Each plan is a standard markdown file with YAML frontmatter metadata.

**File Naming Convention**: Use descriptive kebab-case names that clearly indicate the plan's purpose:
- `agentic-markdown-planning-system.md`
- `claude-code-integration.md`
- `fix-window-state-persistence.md`

### Document Structure

Every plan document follows this structure:

```markdown
---
planStatus:
  planId: plan-unique-identifier
  title: Human Readable Plan Title
  status: draft
  planType: feature
  priority: medium
  owner: username
  stakeholders:
    - stakeholder1
    - stakeholder2
  tags:
    - tag1
    - tag2
  created: "2025-01-15"
  updated: "2025-01-15T14:30:00.000Z"
  progress: 0
---

# Plan Title


## Goals

Clear objectives for this plan...

## System Overview

Description of the system or problem...

## Implementation

Technical details as needed...

## Acceptance Criteria

When is this plan considered complete?
```

### Frontmatter Specification

For complete details on frontmatter fields, status values, plan types, and metadata structure, see the **Agentic Planning System** section in the `CLAUDE.md` file at the repository root.

The frontmatter includes:
- **Plan identification** (planId, title)
- **Status tracking** (status, progress, dates)
- **Organization** (planType, priority, owner, stakeholders)
- **Categorization** (tags)
- **Agent sessions** (agentSessions - automatically managed)

## Real-Time Metadata Caching

Nimbalyst automatically scans, parses, and caches plan metadata for instant access throughout the application.

### How It Works

1. **Document Service**: The `DocumentService` interface (`packages/runtime/src/core/DocumentService.ts`) provides platform-agnostic access to document metadata
2. **Automatic Scanning**: On workspace load, Nimbalyst scans all markdown files for YAML frontmatter
3. **Metadata Extraction**: Files with `planStatus` frontmatter are identified as plan documents
4. **Change Detection**: File watchers detect changes to plan files and automatically update the cache
5. **Event System**: Components subscribe to metadata changes via `watchDocumentMetadata()`

### Cache Features

- **Bounded Reads**: Only reads the first 4KB of each file for frontmatter extraction
- **SHA Hashing**: Tracks frontmatter changes to avoid unnecessary re-parsing
- **Timestamp Tracking**: Records both file modification time and cache index time
- **Error Handling**: Captures and reports YAML parsing errors without breaking the system

### Accessing Plan Metadata

Components can access plan metadata through the document service:

```typescript
// List all plan documents
const metadata = await documentService.listDocumentMetadata();
const plans = metadata.filter(doc => doc.frontmatter.planStatus);

// Watch for changes
const unsubscribe = documentService.watchDocumentMetadata((change) => {
  // Handle added, updated, or removed plans
  console.log('Plans changed:', change);
});
```

## UI Integration

### Plans Panel (Sidebar)

The Plans Panel (`packages/electron/src/renderer/components/PlansPanel/`) displays all plan documents in the workspace sidebar.

**Features**:
- Real-time list of all plan documents
- Search and filter by status, priority, and tags
- Progress indicators and status badges
- Click to open plan document
- Automatically updates when plans change on disk

**Filters**:
- Search by title, owner, or tag
- Filter by status (draft, in-development, completed, etc.)
- Filter by priority (low, medium, high, critical)
- Toggle to hide completed plans

### Plan Status Component (In-Document)

When editing a plan document, a visual Plan Status component appears at the top of the editor. This component is rendered by the `PlanStatusPlugin` (`packages/runtime/src/plugins/PlanStatusPlugin/`).

**Capabilities**:
- **Inline Editing**: Click any field to edit in place
- **Dropdowns**: Select status, priority, and plan type from dropdowns
- **Progress Tracking**: Visual progress bar with slider control
- **Tag Management**: Add/remove tags with keyboard shortcuts
- **Date Display**: Shows creation date and relative update time
- **Agent Sessions**: Launch or open coding sessions directly from the plan

The component automatically syncs edits back to the document's YAML frontmatter, keeping the metadata cache up to date.

### Plan Table Component

Plans can include a `<!-- plan-table -->` comment to render an interactive table of all plans in the workspace. This is useful for creating plan dashboards or roadmap views.

## Agentic Coding Integration

One of the most powerful features of the planning system is its integration with AI coding agents.

### Launching an Agent Session

From any plan document, click the "Launch Agent" button in the Plan Status component. This will:

1. Create a new AI chat session in the workspace
2. Link the session to the plan document
3. Add the session ID to the plan's `agentSessions` array in frontmatter
4. Open the AI chat panel with context about the plan

### Agent Session Tracking

The plan automatically tracks all agent sessions:

```yaml
planStatus:
  # ... other fields ...
  agentSessions:
    - id: "session-uuid-1"
      createdAt: "2025-01-15T10:30:00.000Z"
      status: active
    - id: "session-uuid-2"
      createdAt: "2025-01-14T15:20:00.000Z"
      status: closed
```

**Session States**:
- `active`: Session is open and can be resumed
- `closed`: Session has been completed or archived

### Reopening Sessions

If a plan has active agent sessions, the "Launch Agent" button becomes a session selector. Click it to:
- Open the most recent session (if only one exists)
- Choose from multiple active sessions (if more than one)
- Launch a new session

This allows you to resume work on a plan across multiple coding sessions without losing context.

### Future: Git Commit Tracking

The planning system will soon track git commits associated with each plan. When you commit code while working on a plan, the commit SHAs will be automatically added to the plan's frontmatter:

```yaml
planStatus:
  # ... other fields ...
  commits:
    - sha: "abc123..."
      message: "feat: implement feature X"
      date: "2025-01-15T16:00:00.000Z"
```

This will provide a complete audit trail of all work done for each plan.

## Configuring AI Agents for Plans

To ensure AI coding agents (like Claude Code) correctly create and maintain plan files, add instructions to your `CLAUDE.md` file. The Nimbalyst repository includes a comprehensive "Agentic Planning System" section that explains:

- Plan document location and file naming
- Complete frontmatter metadata structure
- Status values and plan types
- Document structure best practices
- Guidelines for updates and collaboration

**Location**: See the `CLAUDE.md` file at the repository root for the full specification.

**Key Guidelines for AI Agents**:
- Always include complete frontmatter when creating new plans
- Preserve user edits when updating plans
- Update `status`, `progress`, and `updated` fields as work progresses
- Never use emojis in plan documents
- Avoid including code blocks unless absolutely necessary

## Implementation Details

### Key Files

**Plan Status Plugin**:
- `packages/runtime/src/plugins/PlanStatusPlugin/PlanStatusComponent.tsx` - Main UI component
- `packages/runtime/src/plugins/PlanStatusPlugin/PlanStatusDecoratorNode.tsx` - Lexical decorator node
- `packages/runtime/src/plugins/PlanStatusPlugin/PlanStatusTransformer.ts` - Markdown transformer

**Plans Panel**:
- `packages/electron/src/renderer/components/PlansPanel/PlansPanel.tsx` - Sidebar panel
- `packages/electron/src/renderer/components/PlansPanel/PlanListItem.tsx` - Individual plan items
- `packages/electron/src/renderer/components/PlansPanel/PlanFilters.tsx` - Filter controls

**Document Service**:
- `packages/runtime/src/core/DocumentService.ts` - Service interface
- `packages/electron/src/main/services/ElectronDocumentService.ts` - Electron implementation

**IPC Communication**:
- `packages/electron/src/preload/index.ts` - Exposes `window.electronAPI`
- IPC channels: `plan-status:launch-agent-session`, `plan-status:open-agent-session`, `plan-status:agent-session-created`

### Event Flow

**Opening a Plan**:
1. User clicks plan in sidebar
2. PlansPanel calls `documentService.openDocument()`
3. Electron opens document in editor
4. TrackerPlugin detects frontmatter
5. TrackerStatusComponent renders with frontmatter data

**Editing Plan Metadata**:
1. User clicks field in PlanStatusComponent
2. Component updates local state
3. On blur/enter, updates frontmatter via `$setFrontmatter()`
4. Document saves to disk
5. File watcher detects change
6. Document service updates metadata cache
7. PlansPanel receives update event and refreshes

**Launching Agent Session**:
1. User clicks "Launch Agent" button
2. Component sends IPC message to main process
3. Main process creates new AI chat session
4. Session ID is returned to renderer
5. Component updates `agentSessions` in frontmatter
6. IPC event broadcasts session creation
7. All open plan instances receive update

## Best Practices

### For Developers

1. **Create plans early**: Start with a plan document before beginning significant work
2. **Update progress regularly**: Keep the progress field current as you work
3. **Use descriptive titles**: Make plans easy to find in the sidebar
4. **Add relevant tags**: Tags improve discoverability and filtering
5. **Launch agent sessions**: Track which AI sessions are associated with each plan
6. **Review completed plans**: Periodically archive or remove completed plans

### For AI Agents

1. **Always read CLAUDE.md first**: The repository's CLAUDE.md contains the authoritative plan specification
2. **Preserve user edits**: When updating a plan, never overwrite user-made changes
3. **Update timestamps**: Always update the `updated` field when modifying a plan
4. **Follow naming conventions**: Use kebab-case for plan file names
5. **Keep plans focused**: Don't include implementation code unless necessary
6. **Update status as you work**: Change status from "ready-for-development" to "in-development" to "completed"

## Future Enhancements

The planning system is actively evolving. Planned enhancements include:

- **Git commit tracking**: Automatically link commits to plans
- **Dependency tracking**: Mark plans as dependent on other plans
- **Timeline visualization**: Gantt chart view of plan schedules
- **Plan templates**: Quick-create plans from templates
- **Export capabilities**: Export plans to PDF, JIRA, GitHub Issues
- **Automated status updates**: Detect completion via git commits or file changes
- **Cross-workspace plans**: Track plans across multiple workspaces

## Summary

The Nimbalyst planning system transforms markdown files into a powerful project management tool. By combining structured metadata, real-time caching, UI integration, and agentic coding capabilities, it creates a seamless workflow where plans, code, and AI agents work together to move projects forward.

For the complete frontmatter specification and detailed guidelines, refer to the **Agentic Planning System** section in `CLAUDE.md`.
