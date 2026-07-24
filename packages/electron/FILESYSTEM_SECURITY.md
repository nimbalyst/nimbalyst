# Filesystem Security Documentation

## Overview

This document describes the security measures implemented to protect against unauthorized filesystem access when AI tools interact with the local filesystem.

## Security Architecture

### 1. SafePathValidator

The `SafePathValidator` class (`src/main/security/SafePathValidator.ts`) is the core security component that validates all filesystem paths before any operations are performed.

**Key Features:**
- Path traversal prevention (blocks `..`, absolute paths)
- Command injection prevention (blocks shell metacharacters)
- Forbidden path detection (blocks access to sensitive directories)
- File extension filtering (blocks sensitive file types)
- Comprehensive logging of all access attempts

### 2. Security Boundaries

All filesystem operations are strictly confined to the user-selected workspace directory:

```typescript
// Valid paths (within workspace)
✅ "src/app.js"
✅ "components/Button.tsx"
✅ "docs/README.md"

// Blocked paths (security violations)
❌ "../../../etc/passwd"          // Path traversal
❌ "/home/user/.ssh/id_rsa"       // Absolute path
❌ ".ssh/config"                   // Forbidden directory
❌ "secrets.pem"                   // Blocked extension
❌ "file$(whoami).txt"            // Command injection
```

### 3. Defense in Depth

Multiple layers of security ensure robust protection:

1. **Input Validation**: All paths validated before processing
2. **Path Normalization**: Paths normalized to prevent bypasses
3. **Sandboxing**: Operations confined to workspace directory
4. **Command Safety**: Using `execFile` instead of `exec` to prevent shell injection
5. **Logging**: All access attempts logged for audit
6. **Rate Limiting**: Access logs capped to prevent DoS

## Protected Resources

### Forbidden Directories
- `.ssh` - SSH keys and configurations
- `.aws` - AWS credentials
- `.gnupg` - GPG keys
- `.docker` - Docker configurations
- `.kube` - Kubernetes configs
- `Library/Keychains` - macOS keychains
- `Library/Cookies` - Browser cookies
- Browser profile directories

### Blocked File Types
- `.pem`, `.key`, `.cert`, `.crt` - Certificates and keys
- `.env`, `.env.*` - Environment files with secrets
- `.sqlite`, `.db` - Database files
- `.wallet` - Cryptocurrency wallets
- `.keychain`, `.keystore` - Key stores

## Implementation Details

### Path Validation Flow

1. **Input Reception**: Path received from AI tool
2. **Pattern Checking**: Check for dangerous patterns (`.`, `$`, etc.)
3. **Path Resolution**: Safely resolve path within workspace
4. **Boundary Check**: Verify resolved path stays within workspace
5. **Extension Check**: Verify file type is allowed
6. **Access Logging**: Log the access attempt
7. **Operation Execution**: Perform the filesystem operation if valid

### Command Execution Safety

Instead of using shell command interpolation:
```javascript
// ❌ DANGEROUS - Command injection possible
exec(`rg "${query}" "${path}"`);
```

We use argument arrays with execFile:
```javascript
// ✅ SAFE - No shell interpretation
execFile('rg', [query, path]);
```

## Testing

Comprehensive security tests are located in:
- `src/main/security/__tests__/SafePathValidator.test.ts`
- `src/main/services/__tests__/ElectronFileSystemService.security.test.ts`

These tests verify protection against:
- Path traversal attacks
- Command injection attempts
- Unauthorized access to sensitive files
- Edge cases and malformed inputs

## Security Monitoring

### Access Logs

All filesystem access attempts are logged with:
- Timestamp
- Sanitized path (no full paths exposed)
- Operation type (read, list, search)
- Success/failure status

Access logs can be retrieved via:
```typescript
const logs = fileSystemService.getAccessLog(100); // Last 100 entries
```

### Failed Access Alerts

Failed access attempts are logged at WARNING level for security monitoring:
```
[FileSystemService] Access denied: {
  timestamp: "2024-01-15T10:30:00Z",
  path: ".../etc/passwd",
  operation: "read",
  success: false
}
```

## Best Practices

1. **Never trust user input**: All paths must be validated
2. **Fail securely**: Deny access by default
3. **Log everything**: Maintain audit trail
4. **Minimize exposure**: Only expose necessary operations
5. **Regular updates**: Keep security measures current

## Incident Response

If a security violation is detected:

1. **Access is denied** immediately
2. **Violation is logged** with full details
3. **Error returned** to caller without exposing system details
4. **Monitor logs** for repeated attempts

## Future Enhancements

Potential future security improvements:
- [ ] Add rate limiting per operation type
- [ ] Implement file content scanning for sensitive data
- [ ] Add webhook notifications for security events
- [ ] Implement temporary access tokens for operations
- [ ] Add file integrity monitoring

## Contact

For security concerns or to report vulnerabilities, please contact the security team or file an issue with the `security` label.