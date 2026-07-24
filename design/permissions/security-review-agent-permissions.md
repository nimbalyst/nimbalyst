# Security Review: Agent Tool Permission System

## Commit: da315ba1c5a14c06930406a7a7de48e615468479

**Review Date:** 2025-12-20
**Reviewer:** Claude Code Security Analysis

---

## Summary

A comprehensive security review was conducted on the agent tool permission system introduced in this commit. The system implements:

- A permission engine that evaluates tool calls based on workspace trust status
- Bash command parsing using the `shell-quote` library
- Path validation for workspace boundary enforcement
- URL pattern matching for web request controls
- Inline permission prompts with configurable approval scopes

## Methodology

1. **Initial vulnerability identification** via code analysis of key security components
2. **Parallel validation** of each potential finding against false positive criteria
3. **Confidence scoring** to filter out speculative issues

## Key Files Analyzed

| File | Purpose |
|------|---------|
| `packages/runtime/src/ai/permissions/commandParser.ts` | Bash command parsing |
| `packages/runtime/src/ai/permissions/permissionEngine.ts` | Core permission evaluation |
| `packages/runtime/src/ai/permissions/directoryScope.ts` | Path validation |
| `packages/runtime/src/ai/permissions/dangerousPatterns.ts` | Risk detection |
| `packages/runtime/src/ai/server/providers/ClaudeCodeProvider.ts` | SDK integration |
| `packages/electron/src/main/services/PermissionService.ts` | Main process service |

## Findings

**No high-confidence security vulnerabilities were identified.**

Four potential issues were initially flagged but all were validated as false positives:

| Finding | Initial Concern | Validation Result | Confidence |
|---------|----------------|-------------------|------------|
| Path Traversal via Symlinks | String-based path validation doesn't resolve symlinks | User must approve symlink creation commands; workspace trust required | 2/10 - FP |
| Command Substitution Bypass | `$(...)` and backticks may hide true target paths | Path extraction captures targets; fallback to "ask" is safe | 2/10 - FP |
| URL Pattern Wildcard Bypass | `*.safe.com` might match `evil.safe.com.attacker.com` | `endsWith('.' + baseDomain)` check is correct | 2/10 - FP |
| YAML ReDoS | Regex patterns loaded from YAML could cause DoS | Only used in tests; DoS is excluded category | Excluded |

### Detailed Validation

#### 1. Path Traversal via Symlinks

**Initial Concern:** The `directoryScope.ts` uses string-based path comparison without resolving symlinks. An attacker could create `ln -s /etc workspace/etc_link` and then access `/etc/passwd` through the symlink.

**Why It's a False Positive:**
- The AI agent cannot create symlinks without user approval
- The `ln -s` command would go through the permission system and require user consent
- Workspace must be explicitly trusted before any commands run
- This is a hardening improvement, not an exploitable vulnerability

#### 2. Command Substitution Bypass

**Initial Concern:** Commands like `cat $(echo /etc/passwd)` might not have their true target path extracted correctly.

**Why It's a False Positive:**
- The AI agent generates the commands - there's no external attacker
- Path extraction using `shell-quote` still captures paths inside substitutions
- Unrecognized patterns default to "ask", requiring user approval
- No privilege escalation is possible

#### 3. URL Pattern Wildcard Bypass

**Initial Concern:** Pattern `*.safe.com` might incorrectly match `evil.safe.com.attacker.com`.

**Why It's a False Positive:**
- The implementation uses `endsWith('.' + baseDomain)` which correctly validates
- `evil.safe.com.attacker.com` does NOT end with `.safe.com`
- Regex patterns are properly anchored with `^` and `$`

#### 4. YAML ReDoS

**Initial Concern:** YAML-loaded regex patterns could cause catastrophic backtracking.

**Why It's Excluded:**
- The `loadPatternsFromYaml()` function is only used in tests
- Production code uses hardcoded `BUILTIN_PATTERNS`
- DoS vulnerabilities are explicitly out of scope for this review

## Positive Security Observations

The implementation demonstrates solid security design:

### 1. Robust Shell Parsing
Uses the battle-tested `shell-quote` library for reliable command tokenization instead of regex-based parsing.

### 2. Defense-in-Depth
Multiple validation layers:
- Workspace trust status
- Allowed/denied pattern matching
- Path scope validation
- Sensitive location detection
- Destructive command detection

### 3. Safe Defaults
- Untrusted workspaces deny all actions
- Unknown patterns require user approval ("ask")
- Read-only operations are auto-approved within workspace

### 4. Sensitive Path Protection
Blocks access to:
- `~/.ssh/*`
- `~/.aws/*`
- `~/.gnupg/*`
- `/etc/passwd`, `/etc/shadow`
- Environment files with secrets

### 5. Workspace Isolation
File operations are scoped to the project directory by default. Access outside requires explicit user approval.

## Recommendations (Hardening, Not Vulnerabilities)

While not security vulnerabilities, these could be considered for future hardening:

### 1. Symlink Resolution
Consider using `fs.realpathSync()` to resolve actual file paths before validation. This would provide defense-in-depth against potential symlink-based bypasses.

```typescript
// Current (string-based)
const isWithin = normalizedPath.startsWith(normalizedWorkspace);

// Hardened (resolve symlinks)
const realPath = fs.realpathSync(normalizedPath);
const realWorkspace = fs.realpathSync(normalizedWorkspace);
const isWithin = realPath.startsWith(realWorkspace);
```

### 2. Command Substitution Detection
Flag commands containing `$(...)`, backticks, or process substitution `<(...)` for explicit user review, even if the pattern would otherwise be auto-approved.

### 3. Audit Logging
Consider adding structured audit logs for permission decisions to help users understand what actions the agent is taking and why they were allowed/denied.

## Conclusion

The agent tool permission system is well-designed from a security perspective. The combination of workspace trust, pattern-based permissions, path scoping, and safe defaults provides robust protection against unauthorized agent actions.

No changes are required to address security vulnerabilities. The recommended hardening measures are optional improvements for defense-in-depth.

---

## Claude Agent SDK Compliance Review

This section compares our implementation against the official Claude Agent SDK documentation for permissions handling.

**SDK Documentation Source:** https://platform.claude.com/docs/en/agent-sdk/permissions

### Permission Flow Compliance

The SDK defines this permission processing order:
1. PreToolUse Hook
2. Deny Rules
3. Allow Rules
4. Ask Rules
5. Permission Mode Check
6. `canUseTool` Callback
7. PostToolUse Hook

**Our Implementation:** Compliant

Our implementation correctly follows this flow:

```typescript
// ClaudeCodeProvider.ts:462-467
permissionMode: 'default',
canUseTool: this.createCanUseToolHandler(sessionId, workspacePath),
hooks: {
  'PreToolUse': [{ hooks: [this.createPreToolUseHook(workspacePath, sessionId)] }],
  'PostToolUse': [{ hooks: [this.createPostToolUseHook(workspacePath, sessionId)] }],
}
```

### Permission Mode Usage

**SDK Guidance:** Use `default` mode for controlled execution with normal permission checks.

**Our Implementation:** Correct

We explicitly use `permissionMode: 'default'` (line 464) so that:
- `canUseTool` fires for all tools requiring approval
- We can implement custom permission logic through our PermissionEngine
- AskUserQuestion and Bash commands get proper handling

### canUseTool Implementation

**SDK Guidance:** `canUseTool` fires whenever Claude Code would show a permission prompt. It should return either `{ behavior: 'allow', updatedInput: input }` or `{ behavior: 'deny', message: string }`.

**Our Implementation:** Compliant

```typescript
// ClaudeCodeProvider.ts:2097-2102
private createCanUseToolHandler(sessionId?: string, workspacePath?: string) {
  return async (
    toolName: string,
    input: any,
    options: { signal: AbortSignal; suggestions?: any[] }
  ): Promise<{ behavior: 'allow' | 'deny'; updatedInput?: any; message?: string }> => {
```

We correctly:
- Return `{ behavior: 'allow', updatedInput: input }` for allowed tools
- Return `{ behavior: 'deny', message: string }` for denied tools
- Handle the `signal` parameter for abort support

### AskUserQuestion Handling

**SDK Guidance:** When `canUseTool` is called with `toolName: "AskUserQuestion"`, return the user's answers in `updatedInput.answers` as a record mapping question text to selected option labels.

**Our Implementation:** Compliant

Lines 2243-2336 show proper handling:
1. Detect AskUserQuestion tool calls
2. Store pending question resolver
3. Wait for UI to provide answers via IPC
4. Return answers in the correct format: `{ behavior: 'allow', updatedInput: { questions, answers } }`

### PreToolUse Hook

**SDK Guidance:** Hooks execute first and can return `{ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' | 'deny' | 'ask' } }` to control tool execution.

**Our Implementation:** Compliant

We use PreToolUse for:
1. ExitPlanMode confirmation (lines 2355-2427)
2. Planning mode file restriction validation (lines 2458-2468)
3. File tagging before edits (lines 2489-2507)

We correctly return empty `{}` to defer to `canUseTool` when we don't want to block:

```typescript
// ClaudeCodeProvider.ts:2431-2434
// Return empty object to let the request continue through permission flow to canUseTool
if (toolName !== 'Edit' && toolName !== 'Write' && toolName !== 'MultiEdit') {
  return {};
}
```

### Critical SDK Recommendation: allowedTools

**SDK Warning (from our code comment):**

> In agent mode, we intentionally do NOT set allowedTools. Setting `allowedTools: ['*']` would cause all tools to match the "Allow Rules" in the SDK permission flow, bypassing our canUseTool callback.

**Our Implementation:** Correct

Lines 540-544 document this important design decision. By NOT setting `allowedTools`, tools flow through to `canUseTool` where our PermissionEngine can evaluate them properly.

### Best Practices Compliance

| SDK Best Practice | Our Implementation | Status |
|-------------------|-------------------|--------|
| Use default mode for controlled execution | `permissionMode: 'default'` | Compliant |
| Combine modes with hooks for fine-grained control | PreToolUse + canUseTool | Compliant |
| Auto-approve internal tools without prompts | Internal MCP tools auto-allowed | Compliant |
| Handle AskUserQuestion with proper answer format | Question/answer flow via IPC | Compliant |
| Return deny with descriptive message | Includes reason in deny response | Compliant |
| Support abort signal | Checks `options.signal` | Compliant |

### Potential Improvements

1. **Permission Suggestions:** The SDK supports `updatedPermissions` in the allow response for suggesting permission updates. We don't currently use this feature but could add it to allow users to save patterns directly from the approval dialog.

2. **Streaming Permission Mode Changes:** The SDK supports `q.setPermissionMode()` for dynamic mode changes. Our UI doesn't currently expose this capability.

3. **Sandbox Configuration:** The SDK supports sandbox settings for command execution. We implement our own permission engine instead, which provides similar functionality with workspace-scoped controls.

### Conclusion

Our implementation is fully compliant with the Claude Agent SDK's permission handling guidelines. We correctly:

- Use `permissionMode: 'default'` to ensure `canUseTool` fires
- Don't set `allowedTools` in agent mode to preserve permission flow
- Implement proper PreToolUse hooks that return `{}` to defer to `canUseTool`
- Handle AskUserQuestion with the correct answer format
- Return properly structured allow/deny responses from `canUseTool`

No conflicts or violations with SDK recommendations were found.
