# dev.ps1 - Windows equivalent of dev.sh
# Wrapper script for npm run dev that supports --user-data-dir argument
# Usage: .\scripts\dev.ps1 --user-data-dir=C:\path\to\dir

# Parse arguments for --user-data-dir
foreach ($arg in $args) {
    if ($arg -match "^--user-data-dir=(.+)$") {
        $env:NIMBALYST_USER_DATA_DIR = $Matches[1]
        Write-Host "[dev.ps1] Using custom userData directory: $env:NIMBALYST_USER_DATA_DIR"
    }
}

# Run the actual dev command
npm run build:worker
if ($LASTEXITCODE -eq 0) {
    npx electron-vite dev
}
