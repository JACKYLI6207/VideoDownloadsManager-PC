# Build Video Downloads Manager PC — 單一 EXE（onefile）
$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
Set-Location $Root

if (-not (Test-Path ".venv\Scripts\python.exe")) {
    python -m venv .venv
}

& .\.venv\Scripts\pip install -r requirements.txt -q

powershell -ExecutionPolicy Bypass -File "$Root\scripts\prepare_vdm_extension.ps1"

Get-Process -Name "VideoDownloadsManagerPC" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Remove-Item "$Root\_internal" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$Root\VideoDownloadsManagerPC" -Recurse -Force -ErrorAction SilentlyContinue

& .\.venv\Scripts\pyinstaller --noconfirm --clean --distpath $Root --workpath "$Root\build" vdm-pc.spec

Write-Host ""
Write-Host "Done: $Root\VideoDownloadsManagerPC.exe"
Write-Host "Portable: copy VideoDownloadsManagerPC.exe only."
