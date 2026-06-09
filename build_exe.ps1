# Build Video Downloads Manager PC EXE（EXE 直接輸出於專案根目錄）
$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
Set-Location $Root

if (-not (Test-Path ".venv\Scripts\python.exe")) {
    python -m venv .venv
}

& .\.venv\Scripts\pip install -r requirements.txt -q
& .\.venv\Scripts\playwright install chrome 2>$null

& .\.venv\Scripts\pyinstaller --noconfirm --clean --distpath $Root --workpath "$Root\build" vdm-pc.spec
& "$Root\scripts\flatten_exe.ps1" -Root $Root

Write-Host ""
Write-Host "Done: $Root\VideoDownloadsManagerPC.exe"
Write-Host "Chrome browser required for sniffing tab."
