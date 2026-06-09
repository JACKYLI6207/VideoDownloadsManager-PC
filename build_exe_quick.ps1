# 快速建置（略過 pip / playwright，EXE 直接輸出於專案根目錄）
$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
Set-Location $Root

if (-not (Test-Path ".venv\Scripts\pyinstaller.exe")) {
    Write-Host "venv 未就緒，改跑完整建置..."
    & "$Root\build_exe.ps1"
    exit $LASTEXITCODE
}

& .\.venv\Scripts\pyinstaller --noconfirm --distpath $Root --workpath "$Root\build" vdm-pc.spec
& "$Root\scripts\flatten_exe.ps1" -Root $Root

Write-Host ""
Write-Host "Done: $Root\VideoDownloadsManagerPC.exe"
