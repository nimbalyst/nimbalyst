# Verify Authenticode signatures across a packaged Windows tree.
#
# Checks that the payload executable and the installer are both signed by
# NIMBALYST, INC., then sweeps the payload directory for any Windows binary
# that is unsigned or untrusted.
#
# Only Windows PE binaries can carry an Authenticode signature. The packaged
# tree may also contain foreign-platform native modules -- node-pty ships
# Mach-O prebuilds under prebuilds/darwin-* -- and Get-AuthenticodeSignature
# returns UnknownError for those. Filtering on the file extension alone failed
# the v0.72.0 release after its tag had already been pushed, so the sweep tests
# the actual "MZ" PE magic instead.

param(
  [Parameter(Mandatory = $true)][string]$PayloadDir,
  [Parameter(Mandatory = $true)][string]$InstallerPath
)

$ErrorActionPreference = "Stop"

function Test-IsPortableExecutable {
  param([Parameter(Mandatory = $true)][string]$Path)

  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $header = New-Object byte[] 2
    if ($stream.Read($header, 0, 2) -ne 2) {
      return $false
    }
    return ($header[0] -eq 0x4D) -and ($header[1] -eq 0x5A)
  }
  finally {
    $stream.Dispose()
  }
}

$payloadPath = Join-Path $PayloadDir 'Nimbalyst.exe'
if (-not (Test-Path -LiteralPath $payloadPath)) {
  throw "Could not find the staged Windows payload executable at $payloadPath"
}

foreach ($file in @((Get-Item -LiteralPath $payloadPath), (Get-Item -LiteralPath $InstallerPath))) {
  $signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
  $subject = $signature.SignerCertificate.Subject
  if ($signature.Status -ne 'Valid' -or $subject -notmatch 'O="?NIMBALYST, INC\.') {
    throw "Invalid Nimbalyst Windows signature: $($file.FullName) status=$($signature.Status) subject=$subject"
  }
  Write-Host "Verified Windows signature: $($file.FullName) [$subject]"
}

$script:skippedNonPe = 0
$invalidNativeFiles = Get-ChildItem $PayloadDir -File -Recurse |
  Where-Object { $_.Extension -in '.exe', '.dll', '.node' } |
  ForEach-Object {
    if (-not (Test-IsPortableExecutable $_.FullName)) {
      $script:skippedNonPe++
      Write-Host "Skipping non-PE native file: $($_.FullName)"
      return
    }
    $signature = Get-AuthenticodeSignature -LiteralPath $_.FullName
    if ($signature.Status -ne 'Valid') {
      "$($_.FullName) status=$($signature.Status) subject=$($signature.SignerCertificate.Subject)"
    }
  }

if ($script:skippedNonPe -gt 0) {
  Write-Host "Skipped $($script:skippedNonPe) non-PE native file(s) in $PayloadDir"
}

if ($invalidNativeFiles) {
  throw "Unsigned or untrusted native files remain in the Windows payload:`n$($invalidNativeFiles -join "`n")"
}

Write-Host "Windows signature verification passed for $PayloadDir"
