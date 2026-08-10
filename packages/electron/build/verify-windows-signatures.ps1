# Verify Authenticode signatures on the Windows binaries Nimbalyst publishes.
#
# Checks that the payload executable and the installer are both signed by
# NIMBALYST, INC. Those two, plus the NSIS uninstaller, are the only binaries we
# sign: they are what Windows and SmartScreen attribute to us.
#
# This deliberately does NOT sweep the rest of the payload. Signing every nested
# .dll/.node cost 59 DigiCert KeyLocker calls per build (and ~200 on ARM64, where
# a directory-wide `smctl --simple` also signed 142 node_modules .js files),
# exhausting the yearly signing allocation in a week. It also overwrote the
# genuine publisher signatures on bundled third-party binaries (rg.exe,
# codex.exe, libvips) with ours, which is worse provenance, not better. See #853
# for the original payload-signing report.

param(
  [Parameter(Mandatory = $true)][string]$PayloadDir,
  [Parameter(Mandatory = $true)][string]$InstallerPath
)

$ErrorActionPreference = "Stop"

$payloadPath = Join-Path $PayloadDir 'Nimbalyst.exe'
if (-not (Test-Path -LiteralPath $payloadPath)) {
  throw "Could not find the staged Windows payload executable at $payloadPath"
}

$uninstallerPath = Get-ChildItem $PayloadDir -Filter 'Uninstall*.exe' -File |
  Select-Object -First 1

$filesToVerify = @((Get-Item -LiteralPath $payloadPath), (Get-Item -LiteralPath $InstallerPath))
if ($uninstallerPath) {
  $filesToVerify += $uninstallerPath
}

foreach ($file in $filesToVerify) {
  $signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
  $subject = $signature.SignerCertificate.Subject
  if ($signature.Status -ne 'Valid' -or $subject -notmatch 'O="?NIMBALYST, INC\.') {
    throw "Invalid Nimbalyst Windows signature: $($file.FullName) status=$($signature.Status) subject=$subject"
  }
  Write-Host "Verified Windows signature: $($file.FullName) [$subject]"
}

Write-Host "Windows signature verification passed for $PayloadDir"
