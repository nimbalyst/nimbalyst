# Troubleshooting "npx not found" Error on macOS

## Problem
Users report getting the error `"Command 'npx' not found. Node.js needs to be installed to use this MCP server."` even though Node.js is installed and `npx` works in the terminal.

## Root Cause
On macOS, GUI applications launched from Finder or the Dock don't inherit the user's shell PATH environment variable. This means that if Node.js is installed via:
- Homebrew
- nvm (Node Version Manager)
- Custom installation location
- Any non-standard path

...the `npx` command may not be found by Nimbalyst even though it works in the terminal.

## The Fix
The fix implemented in this update does three things:

### 1. Dynamic PATH Detection
The `getEnhancedPath()` function now attempts to get the user's actual shell PATH by explicitly sourcing their shell configuration files:

**For zsh:**
```bash
source /etc/zprofile; source ~/.zprofile; source /etc/zshrc; source ~/.zshrc; echo $PATH
```

**For bash:**
```bash
source /etc/profile; source ~/.bash_profile; source ~/.bashrc; echo $PATH
```

This ensures all version managers (nvm, volta, fnm, asdf) are properly initialized and their paths are included.

### 2. Enhanced Logging
When an MCP server fails to start due to a missing command, the logs now include:
- The command that wasn't found
- The first 500 characters of the enhanced PATH that was used
- Console logs showing whether we successfully got the PATH from the shell

## How to Check the Logs
If a user reports this issue, ask them to:

1. Check the main process log file at:
   ```
   ~/Library/Application Support/@nimbalyst/electron/logs/main.log
   ```

2. Look for entries like:
   ```
   [getEnhancedPath] Got PATH from zsh: /Users/username/.nvm/versions/node/v20.0.0/bin:/opt/homebrew/bin:...
   ```

3. If MCP connection test fails, look for:
   ```
   [MCP Test] Command not found in PATH: npx
   [MCP Test] Enhanced PATH used: /usr/local/bin:/usr/bin:...
   ```

### 3. Version Manager Support
The code now explicitly checks paths for popular Node.js version managers:
- **nvm** - `~/.nvm/current/bin`
- **volta** - `~/.volta/bin`
- **fnm** - `$FNM_DIR/bin`
- **asdf** - `~/.asdf/shims`
- **npm global** - Detected via `npm config get prefix`
- **yarn global** - Detected via `yarn global bin`

## Fallback Paths
If we can't get the PATH from the shell, the code falls back to checking these common locations:

### macOS:
- `/opt/homebrew/bin` (Apple Silicon Homebrew)
- `/opt/homebrew/sbin`
- `/usr/local/bin` (Intel Homebrew)
- `/usr/local/opt/node/bin`
- `/usr/local/opt/node@20/bin`
- `/usr/local/opt/node@18/bin`
- `~/.nvm/current/bin` (nvm)
- `~/.volta/bin` (volta)
- `~/.asdf/shims` (asdf)
- `~/.npm-global/bin`
- `~/.yarn/bin`
- `~/.config/yarn/global/node_modules/.bin`
- `~/.local/bin`
- `~/bin`
- `/opt/local/bin` (MacPorts)
- `$FNM_DIR/bin` (fnm)

### Linux:
- `/usr/local/bin`
- `/usr/bin`
- `/bin`
- `/usr/local/sbin`
- `/usr/sbin`
- `/sbin`
- `/snap/bin`
- `~/.nvm/current/bin` (nvm)
- `~/.volta/bin` (volta)
- `~/.asdf/shims` (asdf)
- `~/.npm-global/bin`
- `~/.yarn/bin`
- `~/.config/yarn/global/node_modules/.bin`
- `~/.local/bin`
- `~/bin`
- `$FNM_DIR/bin` (fnm)

## Troubleshooting Steps

If the user still gets "npx not found" after this fix:

1. **Check if Node.js is actually installed**:
   ```bash
   which npx
   node --version
   ```

2. **Check where npx is located**:
   ```bash
   which npx
   # Example output: /Users/username/.nvm/versions/node/v20.0.0/bin/npx
   ```

3. **Check the shell PATH**:
   ```bash
   echo $PATH
   ```

4. **Check if the shell PATH command works**:
   ```bash
   $SHELL -ilc 'echo $PATH'
   ```

5. **Check the Nimbalyst logs** to see what PATH was actually used

6. **If npx is in a custom location**, the user may need to:
   - Restart Nimbalyst after installing Node.js
   - Ensure their shell configuration (`.zshrc`, `.bashrc`) properly exports the PATH
   - Consider installing Node.js via Homebrew for better macOS integration

## Code Changes
The fix was implemented in:
- `packages/electron/src/main/services/CLIManager.ts` (lines 909-1093)
  - Enhanced shell PATH detection with explicit config file sourcing
  - Added support for volta, fnm, asdf version managers
  - Added yarn global bin detection
  - Improved Windows PATH detection with Volta and Yarn support
- `packages/electron/src/main/services/MCPConfigService.ts` (lines 419, 452, 616-617)
  - Added diagnostic logging for PATH debugging

## Testing
To test this fix:
1. Install Node.js via nvm or in a custom location
2. Try to add an MCP server that uses `npx`
3. Check that the connection test succeeds
4. Check the logs to verify the PATH was detected correctly
