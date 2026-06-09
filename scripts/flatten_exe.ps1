# PyInstaller onedir 會多一層資料夾；將 EXE + _internal 提升到專案根目錄
param(
    [string]$Root = $PSScriptRoot + "\.."
)

$Root = (Resolve-Path $Root).Path
$Bundle = Join-Path $Root "VideoDownloadsManagerPC"

if (-not (Test-Path $Bundle)) {
    Write-Warning "找不到 $Bundle，略過 flatten"
    exit 0
}

Get-ChildItem -Path $Bundle -Force | ForEach-Object {
    $dest = Join-Path $Root $_.Name
    if (Test-Path $dest) {
        Remove-Item $dest -Recurse -Force
    }
    Move-Item -LiteralPath $_.FullName -Destination $dest -Force
}

Remove-Item $Bundle -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "Flatten: $Root\VideoDownloadsManagerPC.exe"
