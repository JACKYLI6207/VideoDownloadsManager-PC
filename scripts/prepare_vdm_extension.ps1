# Build extension/<id>/ from local extension-src/ for PyInstaller bundle.
$ErrorActionPreference = "Stop"
$PcRoot = Split-Path $PSScriptRoot -Parent
$SrcRoot = Join-Path $PcRoot "extension-src"
$ExtId = "anokolhjgbidjccbgmahcgdagmmdoddi"
$Dest = Join-Path $PcRoot "extension\$ExtId"

if (-not (Test-Path (Join-Path $SrcRoot "manifest-pc.json"))) {
    throw "extension-src not found: $SrcRoot"
}

$ExtParent = Join-Path $PcRoot "extension"
if (Test-Path $ExtParent) {
    Remove-Item -Recurse -Force $ExtParent
}
New-Item -ItemType Directory -Path $Dest -Force | Out-Null

$dirs = @("background", "content", "icons", "lib", "offscreen", "sidepanel", "_locales")
foreach ($d in $dirs) {
    $src = Join-Path $SrcRoot $d
    if (Test-Path $src) {
        Copy-Item -Recurse $src (Join-Path $Dest $d)
    }
}

Copy-Item (Join-Path $SrcRoot "manifest-pc.json") (Join-Path $Dest "manifest.json")
Copy-Item (Join-Path $Dest "sidepanel\panel-pc.html") (Join-Path $Dest "sidepanel\panel.html") -Force
Copy-Item (Join-Path $Dest "sidepanel\panel-pc.js") (Join-Path $Dest "sidepanel\panel.js") -Force
Write-Host "VDM PC extension ready: $Dest"
