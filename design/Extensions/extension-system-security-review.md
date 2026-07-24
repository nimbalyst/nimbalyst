---
planStatus:
  planId: plan-extension-security-review
  title: Extension System Security Review
  status: draft
  planType: system-design
  priority: high
  owner: ghinkle
  stakeholders:
    - ghinkle
  tags:
    - extensions
    - security
    - code-review
  created: "2025-12-11"
  updated: "2025-12-11T22:30:00.000Z"
  progress: 0
  startDate: "2025-12-11"
---
# Extension System Security Review

## Executive Summary

This document reviews the security implications of the Nimbalyst extension system. Extensions are dynamically loaded JavaScript modules that run in the renderer process with access to the host application's React instance, DOM, and IPC bridge.

## Current Architecture

### Extension Loading Flow

```
1. Discovery
   ~/Library/Application Support/@nimbalyst/electron/extensions/
   └── extension-name/
       ├── manifest.json    (declares capabilities, permissions)
       └── dist/index.js    (bundled extension code)

2. Loading (ExtensionPlatformServiceImpl.ts)
   - Read manifest.json
   - Read dist/index.js source
   - Transform imports (react, zustand, etc.) to use host dependencies
   - Create blob URL from transformed source
   - Dynamic import() of blob URL
   - Execute activate() function
   - Register components with CustomEditorRegistry

3. Execution
   - Extension code runs in renderer process
   - Same JavaScript context as host app
   - Access to window.__nimbalyst_extensions (React, Zustand, etc.)
   - Access to window.electronAPI (IPC bridge)
```

### Trust Model

**Current state: Full trust**

Extensions currently run with the same privileges as the host application:
- Full DOM access
- Access to all IPC channels via `window.electronAPI`
- Access to host React instance
- Can read/write files via IPC
- Can make network requests
- Can access localStorage/IndexedDB

## Security Concerns

### 1. Code Execution (CRITICAL)

**Risk**: Malicious extension code runs with full renderer privileges.

**Current mitigation**: None. Extensions are trusted.

**Attack vectors**:
- Keylogger via DOM event listeners
- Data exfiltration via fetch/XHR
- Credential theft from localStorage
- File system access via IPC
- Cryptomining
- Ransomware (encrypt files via IPC)

**Recommendations**:
- [ ] Only load extensions from trusted sources (signed, verified)
- [ ] Display clear warnings when installing third-party extensions
- [ ] Consider sandboxing (iframe, Web Worker) for untrusted extensions
- [ ] Implement Content Security Policy restrictions

### 2. IPC Access (HIGH)

**Risk**: Extensions can call any IPC handler via `window.electronAPI.invoke()`.

**Current state**: All IPC channels are accessible.

**Sensitive channels**:
- `file:read`, `file:write` - arbitrary file access
- `workspace:*` - workspace operations
- `ai:*` - AI service access (API keys in memory)
- `shell:*` - if any shell execution exists

**Recommendations**:
- [ ] Implement IPC allowlist per extension based on manifest permissions
- [ ] Audit all IPC handlers for sensitive operations
- [ ] Add permission checks in IPC handlers
- [ ] Log extension IPC calls for auditing

### 3. Manifest Permissions (MEDIUM)

**Risk**: Permissions are declared but not enforced.

**Current state**: `manifest.json` declares permissions but the loader doesn't enforce them.

```json
{
  "permissions": {
    "filesystem": true,
    "ai": true
  }
}
```

**Recommendations**:
- [ ] Implement permission enforcement in ExtensionLoader
- [ ] Create PermissionManager service
- [ ] Block IPC calls that violate declared permissions
- [ ] Prompt user for permission on first use (like mobile apps)

### 4. Import Transformation (MEDIUM)

**Risk**: Import transformation is regex-based and could be bypassed.

**Current state**: Simple regex replacement of import statements.

**Attack vectors**:
- Obfuscated imports that bypass regex
- Dynamic imports (`import()` expressions)
- eval() with import strings
- Accessing global React/Zustand directly

**Recommendations**:
- [ ] Use AST-based transformation instead of regex
- [ ] Block eval(), Function(), and other dynamic code execution
- [ ] Consider using a JavaScript sandbox library

### 5. CSS Injection (LOW)

**Risk**: Extension CSS could affect host UI.

**Current state**: Extension CSS is injected globally.

**Attack vectors**:
- Hide security warnings
- Create fake UI elements (phishing)
- Break host UI layout

**Recommendations**:
- [ ] Scope extension CSS to extension containers
- [ ] Use Shadow DOM for extension UI isolation
- [ ] Block CSS that targets host elements

### 6. React Instance Sharing (LOW)

**Risk**: Extensions share the host's React instance.

**Current state**: Extensions use `window.__nimbalyst_extensions.react`.

**Concerns**:
- Extensions could monkey-patch React
- State bleeding between extensions
- Memory leaks from unmounted components

**Recommendations**:
- [ ] Freeze shared dependencies (`Object.freeze`)
- [ ] Implement cleanup verification on extension unload
- [ ] Consider separate React roots per extension

### 7. Extension Updates (MEDIUM)

**Risk**: Auto-updating extensions could introduce malicious code.

**Current state**: No auto-update mechanism.

**Recommendations**:
- [ ] If implementing auto-update, require signed updates
- [ ] Show changelog before updating
- [ ] Allow pinning extension versions
- [ ] Implement rollback mechanism

## Comparison with Other Systems

### VS Code Extensions

- Run in separate Extension Host process (Node.js)
- Declarative permissions in package.json
- Marketplace with review process
- Sandboxed webviews for UI

### Chrome Extensions

- Manifest V3 with declarative permissions
- Content scripts isolated from page
- Service workers instead of background pages
- Strict CSP requirements

### Figma Plugins

- Run in sandboxed iframe
- Limited API surface
- No direct DOM access
- Message passing for all operations

## Recommended Security Roadmap

### Phase 1: Visibility (Low effort)

1. **Extension audit logging**
  - Log all extension loads/unloads
  - Log IPC calls from extensions
  - Log permission usage

2. **User warnings**
  - Show warning when installing extensions
  - Display extension permissions in settings
  - Mark first-party vs third-party extensions

### Phase 2: Permission Enforcement (Medium effort)

1. **Implement permission system**
  - Define permission scopes
  - Enforce permissions in IPC layer
  - Block unauthorized operations

2. **Permission UI**
  - Show required permissions before install
  - Allow users to revoke permissions
  - Per-workspace permission overrides

### Phase 3: Sandboxing (High effort)

1. **Iframe sandbox for untrusted extensions**
  - Run extension UI in sandboxed iframe
  - Message passing for all operations
  - Limited API surface

2. **Worker-based execution**
  - Run extension logic in Web Worker
  - Proxy API calls through message passing
  - Prevent direct DOM access

### Phase 4: Trust Infrastructure (High effort)

1. **Extension signing**
  - Sign first-party extensions
  - Verify signatures on load
  - Different trust levels

2. **Extension marketplace** (future)
  - Review process for extensions
  - Malware scanning
  - User ratings and reports

## Current Acceptable Use

Given the current trust model, extensions are acceptable for:

- First-party extensions (DatamodelLM, etc.) - Full trust
- Internal/enterprise extensions - Organizational trust
- Open-source extensions with code review - Verified trust

Extensions are NOT safe for:
- Arbitrary third-party extensions
- User-submitted extensions without review
- Extensions from untrusted sources

## Action Items

### Immediate (Before public release)

- [ ] Document that extensions run with full trust
- [ ] Add warning in settings UI about extension risks
- [ ] Audit first-party extensions for security issues

### Short-term (Next quarter)

- [ ] Implement permission enforcement
- [ ] Add extension audit logging
- [ ] Create extension developer guidelines

### Long-term (Future)

- [ ] Evaluate sandboxing options
- [ ] Consider extension signing
- [ ] Plan marketplace security model

## References

- [Electron Security Guidelines](https://www.electronjs.org/docs/latest/tutorial/security)
- [VS Code Extension Security](https://code.visualstudio.com/docs/editor/extension-marketplace#_extension-author-guidelines)
- [Chrome Extension Security](https://developer.chrome.com/docs/extensions/mv3/security/)
- [OWASP Plugin Security](https://owasp.org/www-project-web-security-testing-guide/)
