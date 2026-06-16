# Installation Guide — RTL Support Extension

Three methods for installing the extension on another system.

## Prerequisites (all methods)

- **Node.js ≥ 18** ([nodejs.org](https://nodejs.org))
- **Nimbalyst** installed and run at least once

---

## Method 1: Via Nimbalyst (recommended) ⭐

Best method — Nimbalyst builds and symlinks for you.

### Steps

1. Copy the **source folder** (`rtl-support`) to the target system.
   - No need for `node_modules/` or `dist/` — Nimbalyst builds them.

2. Enable **Extension Dev Tools**:
   `Settings` → `Advanced` → `Extension Dev Tools` on.

3. Install via one of:
   - From a Nimbalyst agent: *"install the extension at `<path>`"*
   - With the MCP tool: `extension_install(path: "<path>")`

4. Wait for the build to finish (a few seconds).

5. ✅ Done. Send a Persian/Arabic/Hebrew message to an agent to see RTL in action.

---

## Method 2: Manual build + copy

If Method 1 doesn't work or Dev Tools isn't available.

### Steps

1. Copy the **source folder** to the target system.

2. Build:
   ```bash
   cd rtl-support
   npm install
   npm run build
   ```
   After build, a `dist/` folder is created.

3. Copy the extension folder to the user extensions path:

   | OS | Path |
   |----|------|
   | **Windows** | `%APPDATA%\@nimbalyst\electron\extensions\` |
   | **macOS** | `~/Library/Application Support/@nimbalyst/electron/extensions/` |
   | **Linux** | `~/.config/@nimbalyst/electron/extensions/` |

   The folder name should be `rtl-support` (or `com.nimbalyst.rtl-support`).

   **Windows (PowerShell):**
   ```powershell
   Copy-Item -Path "C:\path\to\rtl-support" `
             -Destination "$env:APPDATA\@nimbalyst\electron\extensions\" `
             -Recurse
   ```

   **macOS/Linux:**
   ```bash
   cp -r rtl-support \
     ~/Library/Application\ Support/@nimbalyst/electron/extensions/
   # or on Linux: ~/.config/@nimbalyst/electron/extensions/
   ```

4. **Restart Nimbalyst.**

5. ✅ Done. It loads on startup.

---

## Method 3: Pre-built dist only

If you don't want Node.js or source on the target system, copy only the build output.

### Steps

1. On the **developer machine**, build:
   ```bash
   cd rtl-support
   npm run build
   ```

2. Create a folder with this structure:
   ```
   rtl-support/
   ├── manifest.json
   └── dist/
       ├── index.js
       └── index.css
   ```
   (Only `manifest.json` and `dist/` are needed.)

3. Copy this folder to the target system's extensions path (as in Method 2, step 3).

4. **Restart Nimbalyst.**

> ⚠️ **Note**: Method 3 requires no Node.js, but updates are harder. Best for distributing to non-technical users.

---

## Verify installation

After installing, confirm it works:

1. Open Nimbalyst.
2. Open an agent session.
3. Send a message in an RTL language, e.g. *"سلام، یک متن فارسی بنویس"* (Persian) or *"مرحبا"* (Arabic).
4. The agent response should render **right-to-left**.

**Technical check** (optional) — in DevTools console (`Ctrl+Shift+I`):
```javascript
typeof window.nimbalystRtlSupport
// should return "object"
```

---

## Updating

| Method | Update |
|--------|--------|
| Method 1 (devInstall) | Replace source, then `extension_reload(extensionId, path)` |
| Method 2 (manual) | `npm run build` again, replace `dist/`, restart Nimbalyst |
| Method 3 (pre-built) | Replace `dist/`, restart Nimbalyst |

---

## Troubleshooting

**Extension doesn't load:**
- Verify the path (`%APPDATA%\@nimbalyst\electron\extensions\` on Windows)
- Restart Nimbalyst (extensions are only discovered on startup)
- Check the DevTools console for errors

**RTL not applied:**
- Check `typeof window.nimbalystRtlSupport` — if `undefined`, the extension isn't active
- Make sure `rtlSupport.enabled` is `true` in settings
- Enable Extension Dev Tools and inspect logs (`get_logs`)

**To disable:**
- `window.nimbalystRtlSupport.disable()` in the console
- Or remove the extension folder from the extensions path and restart
