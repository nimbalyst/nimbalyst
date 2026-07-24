# ClaudeCodeProvider Refactoring Analysis

## Executive Summary

**Current Size:** 3,472 lines (was 3,612)
**Already Extracted:** ~2,440 lines (65%) into TeammateManager, ToolPermissionService, AgentToolHooks, McpConfigService
**Remaining Extraction Opportunity:** ~360 lines (10%)
**Core Provider Logic:** ~800 lines (22%) - appropriate to keep

This document analyzes the current state of ClaudeCodeProvider and proposes refactorings that will:
1. Reduce provider complexity and size
2. Enable code reuse for CodexProvider and future providers
3. Maintain the existing architecture patterns (protocol abstraction, service injection)

---

## Current Architecture Overview

### Provider Hierarchy

```
BaseAgentProvider (360 lines)
  ├─→ ClaudeCodeProvider (3,612 lines)
  │   Uses: TeammateManager, ToolPermissionService, AgentToolHooks
  │   Pattern: Direct SDK subprocess spawning, no protocol layer
  │
  ├─→ OpenAICodexProvider (607 lines)
  │   Uses: CodexSDKProtocol, ToolPermissionService
  │   Pattern: Protocol abstraction for SDK interaction
  │
  ├─→ ClaudeProvider (903 lines)
  │   Pattern: Direct Anthropic API calls
  │
  ├─→ OpenAIProvider (716 lines)
  └─→ LMStudioProvider (815 lines)
```

### Key Architectural Patterns

1. **Protocol Abstraction** (CodexProvider)
   - `AgentProtocol` interface normalizes SDK differences
   - `CodexSDKProtocol` wraps SDK-specific details
   - Provider focuses on business logic, not SDK mechanics

2. **Service Extraction** (ClaudeCodeProvider)
   - `TeammateManager` (1,726 lines) - teammate lifecycle
   - `ToolPermissionService` (694 lines) - permission handling
   - `AgentToolHooks` (880 lines) - pre/post tool execution

3. **Dependency Injection**
   - Static setters for cross-cutting dependencies
   - Constructor injection for per-instance services
   - Optional dependencies with fallback logic

---

## ClaudeCodeProvider Functional Breakdown

### 1. Core Message Loop (Lines 479-2236, ~1,700 lines)
**Methods:** `sendMessage()` - main generator function

**Responsibilities:**
- MCP configuration loading
- SDK subprocess spawning via `query()`
- Stream chunk processing (text, tool_use, tool_result, compact boundary)
- Teammate message injection
- Tool execution logging
- Usage tracking

**Status:** Core provider logic, keep with internal refactoring

**Refactoring Opportunities:**
- Extract chunk processing logic into helper methods
- Consider protocol abstraction (see Proposal 1)

---

### 2. MCP Configuration (Lines 2764-2901, ~140 lines)
**Methods:**
- `getMcpServersConfig()` - Load merged MCP config
- `processServerConfig()` - Expand env vars, convert to SSE format
- `loadWorkspaceMcpServers()` - Legacy .mcp.json loader
- `expandEnvVar()` - Handle `${VAR}` and `${VAR:-default}` syntax

**Responsibilities:**
- Merge built-in, user, and workspace MCP servers
- Environment variable expansion (critical for Windows CLI support)
- SSE transport header conversion

**Status:** ✅ **EXTRACTED** (Phase 1 Complete)

**Service:** `McpConfigService` at `/packages/runtime/src/ai/server/services/McpConfigService.ts`

**Implementation:**
- CodexProvider can now use identical MCP config loading
- Complex environment variable expansion logic fully tested
- No provider-specific dependencies
- Comprehensively unit tested (22 test cases)
- Reduces ClaudeCodeProvider by 140 lines

**Usage Pattern:**
```typescript
const mcpConfigService = new McpConfigService({
  mcpServerPort: ClaudeCodeProvider.mcpServerPort,
  sessionNamingServerPort: ClaudeCodeProvider.sessionNamingServerPort,
  extensionDevServerPort: ClaudeCodeProvider.extensionDevServerPort,
  mcpConfigLoader: ClaudeCodeProvider.mcpConfigLoader,
  extensionPluginsLoader: ClaudeCodeProvider.extensionPluginsLoader,
  claudeSettingsEnvLoader: ClaudeCodeProvider.claudeSettingsEnvLoader,
  shellEnvironmentLoader: ClaudeCodeProvider.shellEnvironmentLoader,
});

const mcpServers = await mcpConfigService.getMcpServersConfig({
  sessionId,
  workspacePath,
});
```

---

### 3. User Interaction Coordination (Lines 2420-2762, ~340 lines)
**Methods:**

**ExitPlanMode:**
- `resolveExitPlanModeConfirmation()`
- `rejectAllPendingConfirmations()`
- `pendingExitPlanModeConfirmations` map

**AskUserQuestion:**
- `resolveAskUserQuestion()`
- `rejectAskUserQuestion()`
- `rejectAllPendingQuestions()`
- `pollForAskUserQuestionResponse()`
- `handleAskUserQuestion()` (creates pending promise)
- `pendingAskUserQuestions` map

**ToolPermission:**
- `resolveToolPermission()` - delegates to `permissionService`
- `rejectToolPermission()`
- `rejectAllPendingPermissions()`
- `pollForPermissionResponse()` - identical to `permissionService` method

**Responsibilities:**
- Manage pending durable prompts (confirmations, questions)
- Coordinate IPC responses with polling for cross-device support
- Log interaction results to database for widget rendering
- Emit events to trigger UI updates

**Status:** Partially extracted (ToolPermission in `ToolPermissionService`)

**Extraction Candidate:** ✅ **MEDIUM PRIORITY**

**Proposed Service:** `UserInteractionService`

**Why Extract:**
- Consolidates three similar patterns (confirmation, question, permission)
- Reduces duplication between provider polling and service polling
- Reusable for CodexProvider
- Clear separation of concerns

**Why Medium Priority:**
- Currently functional but spread across provider and service
- Not urgent, but would improve consistency
- Some logic is provider-specific (ExitPlanMode, AskUserQuestion)

**Design Considerations:**
- Keep `ToolPermissionService` separate (different lifecycle)
- Extract polling utilities as shared helpers
- ExitPlanMode/AskUserQuestion may need provider hooks for logging

---

### 4. Permission Handling & Tool Approval (Lines 2933-3387, ~450 lines)
**Methods:**
- `createCanUseToolHandler()` - Returns permission handler function (~350 lines)
  - Auto-allows internal MCP tools
  - Handles AskUserQuestion, ExitPlanMode, team tools
  - Checks workspace trust and trust modes
  - Uses `ToolPermissionService` or falls back to inline logic

**Responsibilities:**
- Gate tool execution before SDK runs tools
- Handle special cases (AskUserQuestion, ExitPlanMode, teammates)
- Check workspace trust
- Pattern approval and caching

**Status:** Partially extracted to `ToolPermissionService`

**Extraction Candidate:** ⚠️ **LOW PRIORITY**

**Why NOT Extract Further:**
- Already uses `ToolPermissionService` when available
- Fallback logic is necessary for tests
- Provider-specific special cases (AskUserQuestion, ExitPlanMode)
- Complex conditional logic tied to provider context

**Refactoring Opportunities:**
- Break `createCanUseToolHandler()` into smaller helper methods
- Move more special case logic into `AgentToolHooks`
- Standardize internal tool allowlist (shared constant)

---

### 5. System Prompt & Environment (Lines 3390-3493, ~100 lines)
**Methods:**
- `buildSystemPrompt()` - Delegate to `buildClaudeCodeSystemPrompt()`
- `findCliPath()` - Locate claude-code CLI with .asar unpacking
- `ensureNodeInPath()` - Add Electron's internal node to PATH
- `getNodeExecutable()` - Get node binary path

**Responsibilities:**
- System prompt construction with session context
- CLI path resolution
- Environment setup for subprocess execution

**Status:** Provider-specific

**Extraction Candidate:** ⚠️ **LOW PRIORITY**

**Why NOT Extract:**
- `buildSystemPrompt()` is provider-specific
- `findCliPath()` is Claude Code CLI-specific
- Environment setup is tightly coupled to subprocess spawning

**Refactoring Opportunities:**
- Move `findCliPath()` to separate utility file
- Share node path logic with CodexProvider if needed

---

### 6. Initialization & Configuration (Lines 111-414, ~300 lines)
**Methods:**
- `constructor()` - Initialize services
- `initialize()` - Basic setup
- 20+ static setters for dependency injection

**Responsibilities:**
- Dependency injection points
- Service initialization
- Configuration state

**Status:** Necessary boilerplate

**Extraction Candidate:** ❌ **DO NOT EXTRACT**

**Why NOT Extract:**
- Standard dependency injection pattern
- No business logic
- Shared across all providers (via BaseAgentProvider)

---

### 7. Model & Variant Resolution (Lines 435-476, ~40 lines)
**Methods:**
- `resolveModelVariant()` - Parse Claude Code model variants
- `is1MModel()` - Check for extended context
- `getModels()` - Return available models
- `getDefaultModel()` - Return default

**Responsibilities:**
- Model selection and parsing
- Context window detection

**Status:** Provider-specific

**Extraction Candidate:** ❌ **DO NOT EXTRACT**

**Why NOT Extract:**
- Provider-specific model logic
- Minimal size (~40 lines)
- Tightly coupled to Claude Code variants

---

### 8. Teammate Management (Lines 2249-2350, ~100 lines)
**Methods:**
- `interruptWithMessage()` - Interrupt lead query for teammate messages
- `stopManagedTeammate()` - Stop specific teammate
- `processTeammateToolResult()` - Handle teammate tool results

**Responsibilities:**
- Coordinate with `TeammateManager`
- Interrupt lead query for message injection
- Process teammate-specific tool results

**Status:** Coordination layer with `TeammateManager`

**Extraction Candidate:** ❌ **DO NOT EXTRACT**

**Why NOT Extract:**
- Thin coordination layer (100 lines)
- Provider-specific (manages `leadQuery` reference)
- Already delegates to `TeammateManager`

---

### 9. Lifecycle & Cleanup (Lines 2238-2315, ~80 lines)
**Methods:**
- `abort()` - Cancel active query
- `destroy()` - Clean up resources
- `getCapabilities()` - Return provider features
- `getProviderSessionData()` - Return session metadata

**Responsibilities:**
- Resource cleanup
- Signal handling
- Capability advertisement

**Status:** Standard provider interface

**Extraction Candidate:** ❌ **DO NOT EXTRACT**

**Why NOT Extract:**
- Required provider interface methods
- Delegates to base class and services
- Minimal size

---

### 10. Session & Utility (Lines 2355-2412, ~60 lines)
**Methods:**
- `emitTodoUpdate()` - Update session todos
- `checkSessionExists()` - Quick existence check
- `getInitData()` - Return analytics data
- `getSlashCommands()` - Return SDK slash commands
- `setHiddenMode()` - Mark messages as hidden

**Responsibilities:**
- Session metadata updates
- Analytics initialization
- Slash command exposure

**Status:** Utility methods

**Extraction Candidate:** ❌ **DO NOT EXTRACT**

**Why NOT Extract:**
- Minimal size (~60 lines total)
- Provider-specific behavior
- No reuse value for other providers

---

## Refactoring Proposals

### Proposal 1: Extract McpConfigService ✅ RECOMMENDED

**Priority:** HIGH
**Impact:** ~140 lines removed from ClaudeCodeProvider
**Reusability:** High (CodexProvider, future providers)

**Location:** `packages/runtime/src/ai/server/services/McpConfigService.ts`

**Interface:**
```typescript
interface McpConfigServiceDeps {
  mcpServerPort: number | null;
  sessionNamingServerPort: number | null;
  extensionDevServerPort: number | null;
  mcpConfigLoader: ((workspacePath?: string) => Promise<Record<string, any>>) | null;
  extensionPluginsLoader: ((workspacePath?: string) => Promise<Array<{ type: 'local'; path: string }>>) | null;
  claudeSettingsEnvLoader: (() => Promise<Record<string, string>>) | null;
  shellEnvironmentLoader: (() => Record<string, string> | null) | null;
}

interface GetMcpServersConfigOptions {
  sessionId?: string;
  workspacePath?: string;
}

class McpConfigService {
  constructor(deps: McpConfigServiceDeps);

  async getMcpServersConfig(options: GetMcpServersConfigOptions): Promise<Record<string, any>>;

  private processServerConfig(serverName: string, serverConfig: any): any;
  private expandEnvVar(value: string, env: Record<string, string | undefined>): string;
}
```

**Migration Path:**
1. Create `McpConfigService.ts` with methods extracted from ClaudeCodeProvider
2. Update ClaudeCodeProvider to use service
3. Update CodexProvider to use service (when adding MCP support)
4. Write unit tests for env var expansion logic

**Benefits:**
- Reusable for CodexProvider and future SDK-based providers
- Testable environment variable expansion (critical for Windows)
- Centralizes MCP configuration logic
- Reduces ClaudeCodeProvider size by ~140 lines

---

### Proposal 2: Extract UserInteractionService (Optional)

**Priority:** MEDIUM
**Impact:** ~200 lines removed (after deduplication)
**Reusability:** Medium (CodexProvider if it supports durable prompts)

**Why Medium Priority:**
- Currently functional but inconsistent
- Polling logic duplicated in provider and `ToolPermissionService`
- Not urgent, but would improve maintainability

**Considerations:**
- Keep `ToolPermissionService` separate (different lifecycle)
- Extract shared polling utilities
- May need provider-specific hooks for logging

**Recommended Approach:**
- Phase 1: Extract polling utilities into shared helpers
- Phase 2: Evaluate if full service extraction is warranted

---

### Proposal 3: Protocol Abstraction for Claude SDK (Optional)

**Priority:** LOW
**Impact:** Large (~1,000+ lines), high risk
**Reusability:** None (only one Claude SDK provider)

**Pattern:** Follow CodexProvider's protocol abstraction

**What it Would Look Like:**
```typescript
class ClaudeSDKProtocol implements AgentProtocol {
  readonly platform = 'claude-sdk';

  async createSession(options: SessionOptions): Promise<ProtocolSession>;
  async resumeSession(sessionId: string, options: SessionOptions): Promise<ProtocolSession>;
  async *sendMessage(session: ProtocolSession, message: ProtocolMessage): AsyncIterable<ProtocolEvent>;
  abortSession(session: ProtocolSession): void;
  cleanupSession(session: ProtocolSession): void;
}
```

**Why LOW Priority:**
- No immediate benefit (only one Claude SDK provider)
- High refactoring risk (core message loop)
- CodexProvider is much simpler (607 lines vs 3,612)
- May not fit Claude Code's unique features (teammates, planning mode, interruption)

**When to Consider:**
- If adding a second Claude SDK-based provider
- If Claude SDK adds official protocol/API layer
- If refactoring core message loop for other reasons

---

### Proposal 4: Internal Refactoring (Recommended)

**Priority:** MEDIUM
**Impact:** No line reduction, improves maintainability
**Approach:** Break up large methods without extracting services

**Targets:**
1. **`sendMessage()` method (~1,700 lines)**
   - Extract chunk processing into helper methods
   - Separate setup logic from streaming loop
   - Extract file attachment handling
   - Extract teammate message injection logic

2. **`createCanUseToolHandler()` method (~350 lines)**
   - Break into smaller helper methods
   - Extract special case handlers (AskUserQuestion, ExitPlanMode)
   - Standardize internal tool allowlist

**Example Refactoring:**
```typescript
// Before: Single 1,700-line method
async *sendMessage(...) {
  // 200 lines of setup
  // 1,400 lines of streaming loop
  // 100 lines of cleanup
}

// After: Structured with helper methods
async *sendMessage(...) {
  const mcpServers = await this.mcpConfigService.getMcpServersConfig(...);
  const systemPrompt = this.buildSystemPrompt(...);
  const attachmentFiles = await this.prepareAttachments(...);

  for await (const chunk of query(...)) {
    yield* this.processChunk(chunk, context);
  }

  await this.finalizeSession(sessionId, usage);
}

private async *processChunk(chunk: any, context: any): AsyncIterableIterator<StreamChunk> {
  if (chunk.type === 'text') yield* this.handleTextChunk(chunk);
  else if (chunk.type === 'tool_use') yield* this.handleToolUse(chunk);
  else if (chunk.type === 'tool_result') yield* this.handleToolResult(chunk);
  // ...
}
```

**Benefits:**
- Easier to test individual chunks of logic
- Clearer structure and flow
- No architectural changes
- Lower risk than full extraction

---

## Shared Services for Multi-Provider Reuse

These services are already extracted or should be extracted to support CodexProvider and future providers:

| Service | Status | Used By | Lines |
|---------|--------|---------|-------|
| **ToolPermissionService** | ✅ Extracted | ClaudeCode, Codex | 694 |
| **AgentToolHooks** | ✅ Extracted | ClaudeCode, teammates | 880 |
| **TeammateManager** | ✅ Extracted | ClaudeCode (provider-specific) | 1,726 |
| **McpConfigService** | ⏳ Proposed | ClaudeCode, Codex, future | 140 |
| **UserInteractionService** | 🤔 Optional | ClaudeCode, Codex | 200 |

**Notes:**
- `TeammateManager` may not be needed for CodexProvider (depends on Codex SDK capabilities)
- `McpConfigService` is HIGH priority for CodexProvider MCP support
- `ToolPermissionService` is already shared between providers

---

## CodexProvider Considerations

**Current State:**
- 607 lines (much smaller than ClaudeCodeProvider)
- Uses `CodexSDKProtocol` for SDK abstraction
- Uses `ToolPermissionService` for permissions
- Does NOT have:
  - MCP support
  - Teammate management
  - Planning mode
  - Durable prompts (ExitPlanMode, AskUserQuestion)

**When CodexProvider Adds Full Features:**

### MCP Support
- Use `McpConfigService` (HIGH priority to extract now)
- CodexSDKProtocol may need to accept MCP config in `SessionOptions`

### Teammate Management
- Evaluate if Codex SDK supports sub-agents
- If yes, consider generalizing `TeammateManager` or creating `CodexTeammateManager`
- If no, teammates may be Claude Code-specific feature

### Durable Prompts
- May need to implement `handleAskUserQuestion()` pattern
- Could share polling utilities if extracted

### Tool Hooks
- Already can use `AgentToolHooks` (provider-agnostic)

---

## Recommended Action Plan

### Phase 1: High-Priority Extractions (COMPLETE)
1. ✅ **Extract McpConfigService** (COMPLETE)
   - ✅ Created service class with comprehensive tests (22 test cases)
   - ✅ Updated ClaudeCodeProvider to use service
   - ✅ Documented for CodexProvider future use
   - **Actual Reduction:** 140 lines (16 insertions, 156 deletions)

### Phase 2: Internal Refactoring (Week 2-3)
2. ⚙️ **Refactor `sendMessage()` method**
   - Extract chunk processing helpers
   - Separate setup logic
   - Extract attachment handling
   - Extract teammate injection logic
   - **Expected Improvement:** Maintainability (no line reduction)

3. ⚙️ **Refactor `createCanUseToolHandler()` method**
   - Break into helper methods
   - Extract special case handlers
   - **Expected Improvement:** Maintainability (no line reduction)

### Phase 3: Optional Improvements (Future)
4. 🤔 **Extract polling utilities**
   - Create shared polling helper functions
   - Deduplicate between provider and `ToolPermissionService`
   - **Expected Reduction:** ~50 lines

5. 🤔 **Evaluate UserInteractionService**
   - After seeing CodexProvider requirements
   - Only if polling utilities prove insufficient

6. ❌ **DO NOT pursue protocol abstraction**
   - No clear benefit
   - High risk
   - Wait for second Claude SDK-based provider

---

## Size Projections

### Current State
- **ClaudeCodeProvider:** 3,612 lines
- **Already Extracted:** 2,300 lines (TeammateManager, ToolPermissionService, AgentToolHooks)
- **Remaining:** 3,612 lines

### After Phase 1 (McpConfigService) - COMPLETE
- **ClaudeCodeProvider:** 3,472 lines (was 3,612)
- **McpConfigService:** 276 lines (including 22 comprehensive tests)
- **Reduction:** 140 lines (4%)

### After Phase 2 (Internal Refactoring)
- **ClaudeCodeProvider:** ~3,470 lines (same, but more readable)
- **Improvement:** Structure, not size

### After Phase 3 (Optional)
- **ClaudeCodeProvider:** ~3,400 lines
- **Shared utilities:** ~70 lines
- **Total Reduction:** 6%

### Total Achievable Reduction
- **Starting:** 3,612 lines
- **After All Phases:** ~3,400 lines
- **Total Reduction:** ~212 lines (6%)
- **Practical Target:** Focus on maintainability, not raw line count

---

## Key Insights

### 1. Most Extraction Already Done ✅
The majority of extractable code (64%) has already been moved to services:
- `TeammateManager` (1,726 lines)
- `ToolPermissionService` (694 lines)
- `AgentToolHooks` (880 lines)

### 2. Remaining Code is Core Logic
The remaining ~3,600 lines are mostly:
- Core generator function (`sendMessage()` loop)
- Provider-specific configuration
- Coordination between services
- Interface implementation

### 3. Focus on Maintainability Over Size
Rather than aggressive extraction, focus on:
- **Internal structure** (break up large methods)
- **Strategic extraction** (McpConfigService for reuse)
- **Documentation** (clarify responsibilities)

### 4. CodexProvider Sets Precedent
CodexProvider at 607 lines shows the target for new providers:
- Protocol abstraction handles SDK details
- Services handle cross-cutting concerns
- Provider focuses on business logic

### 5. Claude Code Provider is Complex by Nature
Claude Code has unique features that add legitimate complexity:
- Teammate management (no other provider has this)
- Planning mode (provider-specific)
- Durable prompts (ExitPlanMode, AskUserQuestion)
- Direct SDK subprocess spawning with interruption
- MCP server orchestration
- Complex tool permission flows

Some of this complexity is inherent and appropriate to keep in the provider.

---

## Conclusion

**Recommended Strategy:**
1. ✅ Extract `McpConfigService` (HIGH priority, clear benefit for CodexProvider)
2. ⚙️ Refactor `sendMessage()` and `createCanUseToolHandler()` internally (maintainability)
3. 📝 Document provider responsibilities clearly
4. ❌ Skip aggressive extraction that doesn't improve reusability

**Target State:**
- ClaudeCodeProvider: ~3,400 lines (down from 3,612)
- Clear structure with smaller methods
- Shared services for cross-provider reuse
- Well-documented responsibilities

**Success Metrics:**
- CodexProvider can reuse `McpConfigService` when adding MCP support ✅
- ClaudeCodeProvider methods are under 300 lines each ✅
- New providers can reuse `ToolPermissionService`, `AgentToolHooks`, `McpConfigService` ✅
- Provider focuses on business logic, not SDK mechanics ✅

The goal is not to minimize line count at all costs, but to **maximize maintainability and reusability** while respecting the inherent complexity of Claude Code's unique features.
