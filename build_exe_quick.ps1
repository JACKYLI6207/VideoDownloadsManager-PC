# 快速建置（略過 pip，單一 EXE 輸出於專案根目錄）
$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
Set-Location $Root

if (-not (Test-Path ".venv\Scripts\pyinstaller.exe")) {
    Write-Host "venv 未就緒，改跑完整建置..."
    & "$Root\build_exe.ps1"
    exit $LASTEXITCODE
}

powershell -ExecutionPolicy Bypass -File "$Root\scripts\prepare_vdm_extension.ps1"

Get-Process -Name "VideoDownloadsManagerPC" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Remove-Item "$Root\_internal" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$Root\VideoDownloadsManagerPC" -Recurse -Force -ErrorAction SilentlyContinue

& .\.venv\Scripts\pyinstaller --noconfirm --distpath $Root --workpath "$Root\build" vdm-pc.spec

Write-Host ""
Write-Host "Done: $Root\VideoDownloadsManagerPC.exe"
Write-Host "Portable: copy VideoDownloadsManagerPC.exe only."
