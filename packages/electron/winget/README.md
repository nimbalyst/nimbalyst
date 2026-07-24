# winget manifests

Source-of-truth copies of the winget-pkgs manifests for `Nimbalyst.Nimbalyst`.

## Files

- `Nimbalyst.Nimbalyst.yaml` — version manifest
- `Nimbalyst.Nimbalyst.installer.yaml` — installer URLs, SHA256, architecture
- `Nimbalyst.Nimbalyst.locale.en-US.yaml` — publisher, description, license, tags

These mirror what we submit to
`microsoft/winget-pkgs` under `manifests/n/Nimbalyst/Nimbalyst/<version>/`.

## Submitting a new version

1. Build and publish a stable Windows release to GitHub Releases (the alpha
   channel is not submitted to winget).
2. Compute the SHA256 of `Nimbalyst-Windows-x64.exe`:
```sh
   curl -sLO https://github.com/nimbalyst/nimbalyst/releases/download/vX.Y.Z/Nimbalyst-Windows-x64.exe
   shasum -a 256 Nimbalyst-Windows-x64.exe
```
3. Bump `PackageVersion`, `InstallerUrl`, `InstallerSha256`, `ReleaseDate`, and
   `ReleaseNotesUrl` in the files above.
4. Validate with the winget CLI on a Windows machine:
```sh
   winget validate --manifest packages/electron/winget
```
5. Open a PR to `microsoft/winget-pkgs` placing the three files under
   `manifests/n/Nimbalyst/Nimbalyst/X.Y.Z/`.

## Notes

- x64 only for now — ARM64 ships with a non-EV p12 signature that the winget
  validation bot is likely to flag. Add ARM64 once it's EV-signed.
- `Scope: user` matches the electron-builder NSIS default (per-user install to
  `%LOCALAPPDATA%\Programs\nimbalyst`). If we ever switch to `perMachine: true`,
  change this to `machine`.
- electron-updater continues to auto-update independently of winget. Users on
  the winget channel will receive the same updates either way.
