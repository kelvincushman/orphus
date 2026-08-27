# Orphus 2.1.2

This release adds the first normal Orphus package for Windows x64.

## What changed

- Adds `orphus-windows-x64.zip` to the same release workflow as the macOS arm64
  and Linux x64 packages.
- Builds the Windows executable on a Windows runner, renames it to `orphus.exe`,
  and proves it reports the release version before packaging.
- Includes the Windows ZIP in the published `SHA256SUMS` file.
- Keeps the package intentionally simple: download, verify, extract, and run.
  A managed PowerShell installer and in-place Windows updater are not claimed in
  this release.

## Windows x64

Download these two files from the release:

- `orphus-windows-x64.zip`
- `SHA256SUMS`

Verify and extract them in PowerShell:

```powershell
$checksum = Get-Content .\SHA256SUMS |
  Where-Object { $_ -match 'orphus-windows-x64\.zip$' } |
  Select-Object -First 1
if (-not $checksum) { throw "Windows checksum not found" }
$expected = $checksum.Split()[0].ToLowerInvariant()
$actual = (Get-FileHash .\orphus-windows-x64.zip -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected) { throw "Checksum mismatch" }
Expand-Archive .\orphus-windows-x64.zip -DestinationPath . -Force
.\orphus\orphus.exe
```

macOS and Linux users can continue using `orphus update` or the existing shell
installer.
