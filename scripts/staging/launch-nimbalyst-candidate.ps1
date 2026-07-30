[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$CandidateExecutable,

    [string]$CandidateAppPath,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')]
    [string]$CandidateId,

    [ValidateRange(1, 65535)]
    [int]$CdpPort,

    [switch]$ValidateOnly
)

$ErrorActionPreference = 'Stop'
$stagingRoot = 'D:\Nimbalyst-Staging'
$forbiddenWorkspaceRoot = 'D:\!! CLAUDE'
$defaultCdpPort = 9222

function Resolve-FullPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    return [System.IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
}

function Write-Utf8WithoutBom {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Content
    )

    $encoding = [System.Text.UTF8Encoding]::new($false)
    [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

function Test-IsWithinPath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Parent
    )

    $resolvedPath = Resolve-FullPath -Path $Path
    $resolvedParent = Resolve-FullPath -Path $Parent
    if ($resolvedPath.Equals($resolvedParent, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $true
    }

    $prefix = $resolvedParent + [System.IO.Path]::DirectorySeparatorChar
    return $resolvedPath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)
}

function Assert-IsolatedPath {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string[]]$ForbiddenRoots
    )

    if (-not [System.IO.Path]::IsPathRooted($Path)) {
        throw "$Name must be an absolute path"
    }

    if (-not (Test-IsWithinPath -Path $Path -Parent $stagingRoot)) {
        throw "$Name must stay under $stagingRoot"
    }

    foreach ($forbiddenRoot in $ForbiddenRoots) {
        if ($forbiddenRoot -and (Test-IsWithinPath -Path $Path -Parent $forbiddenRoot)) {
            throw "$Name must be isolated from $forbiddenRoot"
        }
    }
}

function Test-PortAvailable {
    param([Parameter(Mandatory = $true)][int]$Port)

    $listener = $null
    try {
        $listener = [System.Net.Sockets.TcpListener]::new(
            [System.Net.IPAddress]::Loopback,
            $Port
        )
        $listener.Start()
        return $true
    } catch {
        return $false
    } finally {
        if ($null -ne $listener) {
            $listener.Stop()
        }
    }
}

function Find-FreeLoopbackPort {
    do {
        $listener = [System.Net.Sockets.TcpListener]::new(
            [System.Net.IPAddress]::Loopback,
            0
        )
        try {
            $listener.Start()
            $port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
        } finally {
            $listener.Stop()
        }
    } while ($port -eq $defaultCdpPort)

    return $port
}

$candidateExecutablePath = Resolve-FullPath -Path $CandidateExecutable
if (-not (Test-Path -LiteralPath $candidateExecutablePath -PathType Leaf)) {
    throw "Candidate executable does not exist: $candidateExecutablePath"
}
if ([System.IO.Path]::GetExtension($candidateExecutablePath) -ne '.exe') {
    throw "Candidate executable must be a Windows .exe file"
}

$candidateRoot = Join-Path $stagingRoot "candidates\$CandidateId"
$profilePath = Resolve-FullPath -Path (Join-Path $candidateRoot 'user-data')
$workspacePath = Resolve-FullPath -Path (Join-Path $candidateRoot 'workspace')
$claudeProjectsPath = Resolve-FullPath -Path (Join-Path $candidateRoot 'claude-projects')
$receiptDirectory = Resolve-FullPath -Path (Join-Path $candidateRoot 'receipts')
$candidateMainLogPath = Resolve-FullPath -Path (Join-Path $profilePath 'logs\main.log')

$applicationData = [System.Environment]::GetFolderPath(
    [System.Environment+SpecialFolder]::ApplicationData
)
$incumbentProfile = if ($applicationData) {
    Join-Path $applicationData '@nimbalyst\electron'
} else {
    $null
}
$forbiddenRoots = @($forbiddenWorkspaceRoot, $incumbentProfile) | Where-Object { $_ }

$candidateAppFullPath = $null
$candidateAppMainPath = $null
if ($PSBoundParameters.ContainsKey('CandidateAppPath')) {
    if (-not [System.IO.Path]::IsPathRooted($CandidateAppPath)) {
        throw "Candidate app path must be an absolute path"
    }

    $candidateAppFullPath = Resolve-FullPath -Path $CandidateAppPath
    if (-not (Test-Path -LiteralPath $candidateAppFullPath -PathType Container)) {
        throw "Candidate app path does not exist or is not a directory: $candidateAppFullPath"
    }

    foreach ($forbiddenRoot in $forbiddenRoots) {
        if (Test-IsWithinPath -Path $candidateAppFullPath -Parent $forbiddenRoot) {
            throw "Candidate app path must be isolated from $forbiddenRoot"
        }
    }

    $candidatePackagePath = Join-Path $candidateAppFullPath 'package.json'
    if (-not (Test-Path -LiteralPath $candidatePackagePath -PathType Leaf)) {
        throw "Candidate app package.json does not exist: $candidatePackagePath"
    }

    try {
        $candidatePackage = Get-Content -LiteralPath $candidatePackagePath -Raw | ConvertFrom-Json
    } catch {
        throw "Candidate app package.json is not valid JSON: $candidatePackagePath"
    }
    if (-not ($candidatePackage.main -is [string]) -or [string]::IsNullOrWhiteSpace($candidatePackage.main)) {
        throw "Candidate app package.json must define a non-empty main file"
    }

    $candidateAppMainPath = Resolve-FullPath -Path (Join-Path $candidateAppFullPath $candidatePackage.main)
    if (-not (Test-IsWithinPath -Path $candidateAppMainPath -Parent $candidateAppFullPath)) {
        throw "Candidate app main file must stay within the candidate app path"
    }
    if (-not (Test-Path -LiteralPath $candidateAppMainPath -PathType Leaf)) {
        throw "Candidate app main file does not exist: $candidateAppMainPath"
    }
}

foreach ($pathEntry in @(
    @{ Name = 'Profile'; Path = $profilePath },
    @{ Name = 'Workspace'; Path = $workspacePath },
    @{ Name = 'Claude projects directory'; Path = $claudeProjectsPath },
    @{ Name = 'Receipt directory'; Path = $receiptDirectory }
)) {
    Assert-IsolatedPath -Name $pathEntry.Name -Path $pathEntry.Path -ForbiddenRoots $forbiddenRoots
}

$isolatedPaths = @($profilePath, $workspacePath, $claudeProjectsPath)
for ($left = 0; $left -lt $isolatedPaths.Count; $left++) {
    for ($right = $left + 1; $right -lt $isolatedPaths.Count; $right++) {
        if (
            (Test-IsWithinPath -Path $isolatedPaths[$left] -Parent $isolatedPaths[$right]) -or
            (Test-IsWithinPath -Path $isolatedPaths[$right] -Parent $isolatedPaths[$left])
        ) {
            throw "Candidate profile, workspace, and Claude projects paths must be pairwise isolated"
        }
    }
}

if (-not $PSBoundParameters.ContainsKey('CdpPort')) {
    $CdpPort = Find-FreeLoopbackPort
}
if ($CdpPort -eq $defaultCdpPort) {
    throw "CDP port $defaultCdpPort is reserved as the normal Nimbalyst default"
}
if (-not (Test-PortAvailable -Port $CdpPort)) {
    throw "CDP port $CdpPort is not available on loopback"
}

foreach ($directory in @(
    $stagingRoot,
    $candidateRoot,
    $profilePath,
    $workspacePath,
    $claudeProjectsPath,
    $receiptDirectory
)) {
    [void](New-Item -ItemType Directory -Path $directory -Force)
}

$workspaceAnchorPath = Join-Path $workspacePath 'STAGING.md'
if (-not (Test-Path -LiteralPath $workspaceAnchorPath)) {
    $anchorContent = @(
        '# Nimbalyst Candidate Staging Workspace'
        ''
        "Candidate: $CandidateId"
        ''
        'This tiny workspace is intentionally isolated from live Nimbalyst projects.'
    ) -join [System.Environment]::NewLine
    Write-Utf8WithoutBom -Path $workspaceAnchorPath -Content ($anchorContent + [System.Environment]::NewLine)
}

$environmentContract = [ordered]@{
    NIMBALYST_STAGING_MODE = '1'
    NIMBALYST_USER_DATA_DIR = $profilePath
    NIMBALYST_USER_DATA_PATH = $profilePath
    NIMBALYST_CLAUDE_PROJECTS_DIR = $claudeProjectsPath
    NIMBALYST_CDP_PORT = [string]$CdpPort
}

$validatedAtUtc = [System.DateTimeOffset]::UtcNow
$process = $null
$startTimeUtc = $null
$arguments = @()
$candidateProcessName = [System.IO.Path]::GetFileNameWithoutExtension($candidateExecutablePath)
$incumbentMatchingProcessIds = @(
    Get-Process -Name $candidateProcessName -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty Id
)
if ($null -ne $candidateAppFullPath) {
    $arguments += "`"$candidateAppFullPath`""
}
$arguments += @(
    '--workspace',
    "`"$workspacePath`"",
    "--user-data-dir=`"$profilePath`""
)

if (-not $ValidateOnly) {
    $previousEnvironment = @{}
    try {
        foreach ($entry in $environmentContract.GetEnumerator()) {
            $previousEnvironment[$entry.Key] = [System.Environment]::GetEnvironmentVariable(
                $entry.Key,
                [System.EnvironmentVariableTarget]::Process
            )
            [System.Environment]::SetEnvironmentVariable(
                $entry.Key,
                $entry.Value,
                [System.EnvironmentVariableTarget]::Process
            )
        }

        $process = Start-Process `
            -FilePath $candidateExecutablePath `
            -ArgumentList $arguments `
            -WorkingDirectory $workspacePath `
            -WindowStyle Minimized `
            -PassThru
        $process.Refresh()
        $startTimeUtc = $process.StartTime.ToUniversalTime().ToString('o')
    } finally {
        foreach ($entry in $environmentContract.GetEnumerator()) {
            [System.Environment]::SetEnvironmentVariable(
                $entry.Key,
                $previousEnvironment[$entry.Key],
                [System.EnvironmentVariableTarget]::Process
            )
        }
    }
}

$receipt = [ordered]@{
    schemaVersion = 1
    status = if ($ValidateOnly) { 'validated' } else { 'launched' }
    validateOnly = [bool]$ValidateOnly
    candidateId = $CandidateId
    candidateExecutable = $candidateExecutablePath
    candidateAppPath = $candidateAppFullPath
    candidateAppMainPath = $candidateAppMainPath
    launchArguments = $arguments
    processId = if ($null -ne $process) { $process.Id } else { $null }
    startTimeUtc = $startTimeUtc
    validatedAtUtc = $validatedAtUtc.ToString('o')
    profilePath = $profilePath
    workspacePath = $workspacePath
    workspaceAnchorPath = $workspaceAnchorPath
    claudeProjectsPath = $claudeProjectsPath
    receiptDirectory = $receiptDirectory
    cdpPort = $CdpPort
    candidateMainLogPath = $candidateMainLogPath
    environment = $environmentContract
    processComparison = [ordered]@{
        executableProcessName = $candidateProcessName
        incumbentMatchingProcessIds = $incumbentMatchingProcessIds
        candidateProcessId = if ($null -ne $process) { $process.Id } else { $null }
        candidateDistinctFromIncumbents = if ($null -ne $process) {
            $incumbentMatchingProcessIds -notcontains $process.Id
        } else {
            $null
        }
    }
    isolation = [ordered]@{
        stagingRoot = $stagingRoot
        forbiddenWorkspaceRoot = $forbiddenWorkspaceRoot
        incumbentProfile = $incumbentProfile
        pairwiseIsolated = $true
    }
}

$receiptFileName = '{0}-{1}.json' -f $receipt.status, $validatedAtUtc.ToString('yyyyMMddTHHmmssfffZ')
$receiptPath = Join-Path $receiptDirectory $receiptFileName
$receiptJson = $receipt | ConvertTo-Json -Depth 6
Write-Utf8WithoutBom -Path $receiptPath -Content ($receiptJson + [System.Environment]::NewLine)

Write-Output $receiptPath
