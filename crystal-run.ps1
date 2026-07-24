# crystal-run.ps1 - Windows equivalent of crystal-run.sh
# Run Nimbalyst in development mode with smart rebuild detection

$ErrorActionPreference = "Stop"

# Use a different port for crystal-run to avoid conflicts with production builds
$DEV_PORT = 5274

# Store the script's starting directory
$SCRIPT_DIR = $PSScriptRoot
if (-not $SCRIPT_DIR) {
    $SCRIPT_DIR = Get-Location
}

# Variables for worktree detection
$script:WORKTREE_MODE = $false
$script:MAIN_REPO_ROOT = ""

# Detect if we're in a git worktree and find the main repo root
function Detect-Worktree {
    $script:WORKTREE_MODE = $false
    $script:MAIN_REPO_ROOT = ""

    $gitFile = Join-Path $SCRIPT_DIR ".git"

    # Check if .git is a file (worktree) rather than a directory (main repo)
    if (Test-Path $gitFile -PathType Leaf) {
        $script:WORKTREE_MODE = $true
        # Parse the gitdir from the .git file to find the main repo
        $fileContent = Get-Content $gitFile -Raw
        $gitdir = $fileContent -replace "gitdir:\s*", "" -replace "`r`n", "" -replace "`n", ""
        # The gitdir points to .git/worktrees/<name>, so go up 3 levels to get main repo
        $script:MAIN_REPO_ROOT = (Resolve-Path (Join-Path $gitdir "..\..\..")).Path
        Write-Host "Worktree detected. Main repo: $($script:MAIN_REPO_ROOT)"
    }
}

# Check if a package has local changes compared to main repo
function Package-HasWorktreeChanges {
    param([string]$pkgDir)

    if (-not $script:WORKTREE_MODE) {
        return $true
    }

    $mainPkgDir = Join-Path $script:MAIN_REPO_ROOT $pkgDir

    if (-not (Test-Path $mainPkgDir)) {
        return $true
    }

    $localSrc = Join-Path (Join-Path $SCRIPT_DIR $pkgDir) "src"
    $mainSrc = Join-Path $mainPkgDir "src"

    if ((Test-Path $localSrc) -and (Test-Path $mainSrc)) {
        # Compare directories by hashing all files
        $localFiles = Get-ChildItem $localSrc -Recurse -File | Sort-Object FullName
        $mainFiles = Get-ChildItem $mainSrc -Recurse -File | Sort-Object FullName

        # Quick check: different file counts means changes
        if ($localFiles.Count -ne $mainFiles.Count) {
            return $true
        }

        # Compare relative paths and hashes
        foreach ($localFile in $localFiles) {
            $relativePath = $localFile.FullName.Substring($localSrc.Length)
            $mainFile = Join-Path $mainSrc $relativePath
            if (-not (Test-Path $mainFile)) {
                return $true
            }
            $localHash = (Get-FileHash $localFile.FullName -Algorithm SHA256).Hash
            $mainHash = (Get-FileHash $mainFile -Algorithm SHA256).Hash
            if ($localHash -ne $mainHash) {
                return $true
            }
        }
    }

    $configFiles = @("vite.config.ts", "package.json", "tsconfig.json")
    foreach ($configFile in $configFiles) {
        $localConfig = Join-Path (Join-Path $SCRIPT_DIR $pkgDir) $configFile
        $mainConfig = Join-Path $mainPkgDir $configFile

        if ((Test-Path $localConfig) -or (Test-Path $mainConfig)) {
            if ((Test-Path $localConfig) -and (Test-Path $mainConfig)) {
                $localHash = (Get-FileHash $localConfig -Algorithm SHA256).Hash
                $mainHash = (Get-FileHash $mainConfig -Algorithm SHA256).Hash
                if ($localHash -ne $mainHash) {
                    return $true
                }
            } else {
                return $true
            }
        }
    }

    return $false
}

function Main-RepoHasDist {
    param([string]$pkgDir)

    if (-not $script:WORKTREE_MODE) {
        return $false
    }

    $mainDist = Join-Path (Join-Path $script:MAIN_REPO_ROOT $pkgDir) "dist"
    return (Test-Path $mainDist) -and ((Get-ChildItem $mainDist -ErrorAction SilentlyContinue | Measure-Object).Count -gt 0)
}

function Copy-DistFromMainRepo {
    param([string]$pkgDir)

    $mainDist = Join-Path (Join-Path $script:MAIN_REPO_ROOT $pkgDir) "dist"
    $localDist = Join-Path (Join-Path $SCRIPT_DIR $pkgDir) "dist"

    Write-Host "  Copying dist from main repo for $pkgDir..."
    if (Test-Path $localDist) {
        Remove-Item $localDist -Recurse -Force
    }
    Copy-Item $mainDist $localDist -Recurse
}

function Compute-SourceHash {
    param([string]$pkgDir)

    $fullPkgDir = Join-Path $SCRIPT_DIR $pkgDir
    $srcDir = Join-Path $fullPkgDir "src"

    $hashInput = ""

    if (Test-Path $srcDir) {
        $sourceFiles = Get-ChildItem $srcDir -Recurse -File -Include "*.ts", "*.tsx", "*.css", "*.js" | Sort-Object FullName
        foreach ($file in $sourceFiles) {
            $hashInput += (Get-FileHash $file.FullName -Algorithm SHA256).Hash
        }
    }

    $configFiles = @("vite.config.ts", "package.json")
    foreach ($configFile in $configFiles) {
        $configPath = Join-Path $fullPkgDir $configFile
        if (Test-Path $configPath) {
            $hashInput += (Get-FileHash $configPath -Algorithm SHA256).Hash
        }
    }

    $stringAsStream = [System.IO.MemoryStream]::new()
    $writer = [System.IO.StreamWriter]::new($stringAsStream)
    $writer.Write($hashInput)
    $writer.Flush()
    $stringAsStream.Position = 0
    return (Get-FileHash -InputStream $stringAsStream -Algorithm SHA256).Hash
}

function Needs-Rebuild {
    param([string]$pkgDir)

    $hashFile = Join-Path (Join-Path (Join-Path $SCRIPT_DIR $pkgDir) "dist") ".build-hash"

    if (-not (Test-Path $hashFile)) {
        return $true
    }

    $currentHash = Compute-SourceHash $pkgDir
    $storedHash = Get-Content $hashFile -Raw -ErrorAction SilentlyContinue
    if ($storedHash) {
        $storedHash = $storedHash.Trim()
    }

    return $currentHash -ne $storedHash
}

function Save-BuildHash {
    param([string]$pkgDir)

    $hashFile = Join-Path (Join-Path (Join-Path $SCRIPT_DIR $pkgDir) "dist") ".build-hash"
    $hash = Compute-SourceHash $pkgDir

    $distDir = Join-Path (Join-Path $SCRIPT_DIR $pkgDir) "dist"
    if (-not (Test-Path $distDir)) {
        New-Item -ItemType Directory -Path $distDir -Force | Out-Null
    }

    $hash | Out-File $hashFile -NoNewline -Encoding UTF8
}

Write-Host "Killing any existing dev processes from crystal-run..."

$killedAny = $false

# Kill Electron dev processes
$electronProcesses = Get-Process -Name "electron", "Electron", "nimbalyst" -ErrorAction SilentlyContinue
foreach ($proc in $electronProcesses) {
    try {
        $cmdLine = (Get-CimInstance Win32_Process -Filter "ProcessId = $($proc.Id)" -ErrorAction SilentlyContinue).CommandLine

        # Skip packaged apps
        if ($cmdLine -match "Program Files" -or $cmdLine -match "AppData\\Local\\Programs") {
            continue
        }

        if ($cmdLine -match "packages[/\\]electron" -or $cmdLine -match "RUN_ONE_DEV_MODE") {
            Write-Host "  Killing Electron dev process $($proc.Id)"
            Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
            $killedAny = $true
        }
    } catch { }
}

# Kill Vite/node dev servers
$nodeProcesses = Get-Process -Name "node" -ErrorAction SilentlyContinue
foreach ($proc in $nodeProcesses) {
    try {
        $cmdLine = (Get-CimInstance Win32_Process -Filter "ProcessId = $($proc.Id)" -ErrorAction SilentlyContinue).CommandLine
        if ($cmdLine -match "vite.*--port" -or $cmdLine -match "packages[/\\]electron") {
            Write-Host "  Killing node process $($proc.Id)"
            Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
            $killedAny = $true
        }
    } catch { }
}

# Kill processes on the dev port
try {
    $portProcesses = Get-NetTCPConnection -LocalPort $DEV_PORT -ErrorAction SilentlyContinue |
                     Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($procId in $portProcesses) {
        $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
        if ($proc) {
            Write-Host "  Killing process $procId on port $DEV_PORT"
            Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
            $killedAny = $true
        }
    }
} catch { }

if ($killedAny) {
    Write-Host "Killed dev processes"
    Start-Sleep -Seconds 2
} else {
    Write-Host "No dev processes found to kill"
}

Detect-Worktree

# Check for a proper node_modules (not just a partial/broken one)
$nodeModulesPath = Join-Path $SCRIPT_DIR "node_modules"
$needsNpmInstall = $true
if (Test-Path $nodeModulesPath) {
    # Check if key packages exist to verify node_modules is complete
    $esbuildPath = Join-Path $nodeModulesPath "esbuild"
    $vitePath = Join-Path $nodeModulesPath "vite"
    $esbuildBinaryPath = Join-Path $nodeModulesPath "@esbuild\win32-arm64"
    $rollupBinaryPath = Join-Path $nodeModulesPath "@rollup\rollup-win32-arm64-msvc"
    $electronPath = Join-Path $nodeModulesPath "electron"
    $electronDistPath = Join-Path $electronPath "dist"
    if ((Test-Path $esbuildPath) -and (Test-Path $vitePath) -and (Test-Path $esbuildBinaryPath) -and (Test-Path $rollupBinaryPath) -and (Test-Path $electronDistPath)) {
        # Check version compatibility for main esbuild
        $esbuildPkgJson = Join-Path $nodeModulesPath "esbuild\package.json"
        $esbuildBinaryPkgJson = Join-Path $nodeModulesPath "@esbuild\win32-arm64\package.json"
        $mainVersionsMatch = $false
        if ((Test-Path $esbuildPkgJson) -and (Test-Path $esbuildBinaryPkgJson)) {
            $esbuildVer = (Get-Content $esbuildPkgJson | ConvertFrom-Json).version
            $esbuildBinaryVer = (Get-Content $esbuildBinaryPkgJson | ConvertFrom-Json).version
            if ($esbuildVer -eq $esbuildBinaryVer) {
                $mainVersionsMatch = $true
            } else {
                Write-Host "esbuild version mismatch ($esbuildVer vs $esbuildBinaryVer), will fix..."
            }
        }
        # Also check vite's nested esbuild
        $viteEsbuildPkgJson = Join-Path $nodeModulesPath "vite\node_modules\esbuild\package.json"
        $viteVersionsMatch = $true  # Assume true if vite doesn't have nested esbuild
        if (Test-Path $viteEsbuildPkgJson) {
            $viteEsbuildVer = (Get-Content $viteEsbuildPkgJson | ConvertFrom-Json).version
            $viteBinaryPath = Join-Path $nodeModulesPath "@esbuild\win32-arm64\package.json"
            if (Test-Path $viteBinaryPath) {
                $installedBinaryVer = (Get-Content $viteBinaryPath | ConvertFrom-Json).version
                # Check if any installed binary matches vite's version
                # Since we only have one @esbuild/win32-arm64, check if it matches vite's version
                # If not, we need to install the correct version
                if ($viteEsbuildVer -ne $esbuildBinaryVer -and $viteEsbuildVer -ne $installedBinaryVer) {
                    $viteVersionsMatch = $false
                    Write-Host "vite's esbuild version ($viteEsbuildVer) needs binary..."
                }
            }
        }
        if ($mainVersionsMatch -and $viteVersionsMatch) {
            $needsNpmInstall = $false
        }
    } else {
        Write-Host "Incomplete node_modules detected, will reinstall..."
        Remove-Item $nodeModulesPath -Recurse -Force -ErrorAction SilentlyContinue
        # Also remove package-lock.json to avoid npm bugs with optional deps
        $lockFile = Join-Path $SCRIPT_DIR "package-lock.json"
        if (Test-Path $lockFile) {
            Remove-Item $lockFile -Force -ErrorAction SilentlyContinue
        }
    }
}

# Build flags
$buildRuntime = $false
$buildExtensionSdk = $false
$buildExtensions = $false
$buildRuntimeReason = ""
$buildExtensionSdkReason = ""
$buildExtensionsReason = ""
$copyRuntimeFromMain = $false
$copyExtensionSdkFromMain = $false
$copyExtensionsFromMain = $false

# Check runtime
if ($script:WORKTREE_MODE) {
    if (Package-HasWorktreeChanges "packages/runtime") {
        if (Needs-Rebuild "packages/runtime") {
            $buildRuntime = $true
            $buildRuntimeReason = " (local changes)"
        }
    } elseif (Main-RepoHasDist "packages/runtime") {
        if (-not (Test-Path (Join-Path $SCRIPT_DIR "packages/runtime/dist"))) {
            $copyRuntimeFromMain = $true
        }
    } else {
        if (Needs-Rebuild "packages/runtime") {
            $buildRuntime = $true
        }
    }
} else {
    if (Needs-Rebuild "packages/runtime") {
        $buildRuntime = $true
    }
}

# Check extension-sdk
if ($script:WORKTREE_MODE) {
    if (Package-HasWorktreeChanges "packages/extension-sdk") {
        if (Needs-Rebuild "packages/extension-sdk") {
            $buildExtensionSdk = $true
            $buildExtensionSdkReason = " (local changes)"
        }
    } elseif (Main-RepoHasDist "packages/extension-sdk") {
        if (-not (Test-Path (Join-Path $SCRIPT_DIR "packages/extension-sdk/dist"))) {
            $copyExtensionSdkFromMain = $true
        }
    } else {
        if (Needs-Rebuild "packages/extension-sdk") {
            $buildExtensionSdk = $true
        }
    }
} else {
    if (Needs-Rebuild "packages/extension-sdk") {
        $buildExtensionSdk = $true
    }
}

# Check extensions
if ($script:WORKTREE_MODE) {
    if (Package-HasWorktreeChanges "packages/extensions/pdf-viewer") {
        if (Needs-Rebuild "packages/extensions/pdf-viewer") {
            $buildExtensions = $true
            $buildExtensionsReason = " (local changes)"
        }
    } elseif (Main-RepoHasDist "packages/extensions/pdf-viewer") {
        if (-not (Test-Path (Join-Path $SCRIPT_DIR "packages/extensions/pdf-viewer/dist"))) {
            $copyExtensionsFromMain = $true
        }
    } else {
        if (Needs-Rebuild "packages/extensions/pdf-viewer") {
            $buildExtensions = $true
        }
    }
} else {
    if (Needs-Rebuild "packages/extensions/pdf-viewer") {
        $buildExtensions = $true
    }
}

# Print build plan
Write-Host ""
Write-Host "Build plan:"

if ($copyRuntimeFromMain) { Write-Host "  runtime: COPY from main repo (no local changes)" }
elseif ($buildRuntime) { Write-Host "  runtime: BUILD$buildRuntimeReason" }
else { Write-Host "  runtime: skip (up-to-date)" }

if ($copyExtensionSdkFromMain) { Write-Host "  extension-sdk: COPY from main repo (no local changes)" }
elseif ($buildExtensionSdk) { Write-Host "  extension-sdk: BUILD$buildExtensionSdkReason" }
else { Write-Host "  extension-sdk: skip (up-to-date)" }

if ($copyExtensionsFromMain) { Write-Host "  extensions: COPY from main repo (no local changes)" }
elseif ($buildExtensions) { Write-Host "  extensions: BUILD$buildExtensionsReason" }
else { Write-Host "  extensions: skip (up-to-date)" }
Write-Host ""

# Execute build plan
Push-Location $SCRIPT_DIR
try {
    if ($needsNpmInstall) {
        # In worktree mode, try to copy node_modules from main repo first (much faster)
        if ($script:WORKTREE_MODE) {
            $mainNodeModules = Join-Path $script:MAIN_REPO_ROOT "node_modules"
            if (Test-Path $mainNodeModules) {
                Write-Host "Copying node_modules from main repo (this may take a minute)..."
                $localNodeModules = Join-Path $SCRIPT_DIR "node_modules"

                # Use robocopy for faster copying with full path
                $robocopyPath = Join-Path $env:SystemRoot "System32\robocopy.exe"
                if (Test-Path $robocopyPath) {
                    & $robocopyPath $mainNodeModules $localNodeModules /E /NFL /NDL /NJH /NJS /nc /ns /np
                } else {
                    Copy-Item $mainNodeModules $localNodeModules -Recurse -Force
                }
                Write-Host "node_modules copied from main repo"
            } else {
                Write-Host "Installing dependencies..."
                # First install with --ignore-scripts to skip problematic native modules
                npm install --ignore-scripts
                if ($LASTEXITCODE -ne 0) {
                    Write-Host "npm install had errors"
                }
                # Now install the platform-specific binary packages explicitly
                Write-Host "Installing platform-specific binaries..."
                # Get the esbuild version from the installed package
                $esbuildPkgJson = Join-Path $SCRIPT_DIR "node_modules\esbuild\package.json"
                $esbuildVersion = "0.25.12"  # Default
                if (Test-Path $esbuildPkgJson) {
                    $esbuildPkg = Get-Content $esbuildPkgJson | ConvertFrom-Json
                    $esbuildVersion = $esbuildPkg.version
                }
                # Get the rollup version from the installed package
                $rollupPkgJson = Join-Path $SCRIPT_DIR "node_modules\rollup\package.json"
                $rollupVersion = "4.44.0"  # Default
                if (Test-Path $rollupPkgJson) {
                    $rollupPkg = Get-Content $rollupPkgJson | ConvertFrom-Json
                    $rollupVersion = $rollupPkg.version
                }
                npm install "@esbuild/win32-arm64@$esbuildVersion" "@rollup/rollup-win32-arm64-msvc@$rollupVersion" --ignore-scripts --no-save
                # Also install binary for vite's nested esbuild if version differs
                $viteEsbuildPkgJson = Join-Path $SCRIPT_DIR "node_modules\vite\node_modules\esbuild\package.json"
                if (Test-Path $viteEsbuildPkgJson) {
                    $viteEsbuildVersion = (Get-Content $viteEsbuildPkgJson | ConvertFrom-Json).version
                    if ($viteEsbuildVersion -ne $esbuildVersion) {
                        Write-Host "Installing esbuild binary for vite ($viteEsbuildVersion) into vite's node_modules..."
                        # Install into vite's nested node_modules so it doesn't conflict
                        $viteNodeModules = Join-Path $SCRIPT_DIR "node_modules\vite\node_modules"
                        Push-Location $viteNodeModules
                        npm install "@esbuild/win32-arm64@$viteEsbuildVersion" --ignore-scripts --no-save
                        Pop-Location
                    }
                }
                # Run electron's install script to download the electron binary
                Write-Host "Installing Electron binary..."
                $electronPkg = Join-Path $SCRIPT_DIR "node_modules\electron"
                if (Test-Path $electronPkg) {
                    Push-Location $electronPkg
                    node install.js
                    Pop-Location
                }
            }
        } else {
            Write-Host "Installing dependencies..."
            # First install with --ignore-scripts to skip problematic native modules
            npm install --ignore-scripts
            if ($LASTEXITCODE -ne 0) {
                Write-Host "npm install had errors"
            }
            # Now install the platform-specific binary packages explicitly (--no-save to avoid modifying package.json)
            Write-Host "Installing platform-specific binaries..."
            # Get the esbuild version from the installed package
            $esbuildPkgJson = Join-Path $SCRIPT_DIR "node_modules\esbuild\package.json"
            $esbuildVersion = "0.25.12"  # Default
            if (Test-Path $esbuildPkgJson) {
                $esbuildPkg = Get-Content $esbuildPkgJson | ConvertFrom-Json
                $esbuildVersion = $esbuildPkg.version
            }
            # Get the rollup version from the installed package
            $rollupPkgJson = Join-Path $SCRIPT_DIR "node_modules\rollup\package.json"
            $rollupVersion = "4.44.0"  # Default
            if (Test-Path $rollupPkgJson) {
                $rollupPkg = Get-Content $rollupPkgJson | ConvertFrom-Json
                $rollupVersion = $rollupPkg.version
            }
            npm install "@esbuild/win32-arm64@$esbuildVersion" "@rollup/rollup-win32-arm64-msvc@$rollupVersion" --ignore-scripts --no-save
            # Also install binary for vite's nested esbuild if version differs
            $viteEsbuildPkgJson = Join-Path $SCRIPT_DIR "node_modules\vite\node_modules\esbuild\package.json"
            if (Test-Path $viteEsbuildPkgJson) {
                $viteEsbuildVersion = (Get-Content $viteEsbuildPkgJson | ConvertFrom-Json).version
                if ($viteEsbuildVersion -ne $esbuildVersion) {
                    Write-Host "Installing esbuild binary for vite ($viteEsbuildVersion) into vite's node_modules..."
                    # Install into vite's nested node_modules so it doesn't conflict
                    $viteNodeModules = Join-Path $SCRIPT_DIR "node_modules\vite\node_modules"
                    Push-Location $viteNodeModules
                    npm install "@esbuild/win32-arm64@$viteEsbuildVersion" --ignore-scripts --no-save
                    Pop-Location
                }
            }
            # Run electron's install script to download the electron binary
            Write-Host "Installing Electron binary..."
            $electronPkg = Join-Path $SCRIPT_DIR "node_modules\electron"
            if (Test-Path $electronPkg) {
                Push-Location $electronPkg
                node install.js
                Pop-Location
            }
        }
    }

    if ($copyRuntimeFromMain) { Copy-DistFromMainRepo "packages/runtime" }
    elseif ($buildRuntime) {
        Write-Host "Building runtime package..."
        Push-Location (Join-Path $SCRIPT_DIR "packages/runtime")
        npx vite build
        Pop-Location
        Save-BuildHash "packages/runtime"
    }

    if ($copyExtensionSdkFromMain) { Copy-DistFromMainRepo "packages/extension-sdk" }
    elseif ($buildExtensionSdk) {
        Write-Host "Building extension-sdk package..."
        Push-Location (Join-Path $SCRIPT_DIR "packages/extension-sdk")
        npx tsc
        Pop-Location
        Save-BuildHash "packages/extension-sdk"
    }

    if ($copyExtensionsFromMain) { Copy-DistFromMainRepo "packages/extensions/pdf-viewer" }
    elseif ($buildExtensions) {
        Write-Host "Building extensions..."
        Push-Location (Join-Path $SCRIPT_DIR "packages/extensions/pdf-viewer")
        npx vite build
        Pop-Location
        Save-BuildHash "packages/extensions/pdf-viewer"
    }

    Write-Host "Starting Nimbalyst on port $DEV_PORT with isolated user data..."
    Push-Location (Join-Path $SCRIPT_DIR "packages/electron")

    $env:VITE_PORT = $DEV_PORT
    $env:RUN_ONE_DEV_MODE = "true"

    # Build worker and run electron-vite directly (Windows-compatible)
    Write-Host "Building worker..."
    node build/build-worker.js
    Write-Host "Starting electron-vite dev..."
    # Increase Node memory limit for large codebases
    $env:NODE_OPTIONS = "--max-old-space-size=8192"
    npx electron-vite dev

    Pop-Location

    Write-Host "Nimbalyst has been launched!"
} finally {
    Pop-Location
}
