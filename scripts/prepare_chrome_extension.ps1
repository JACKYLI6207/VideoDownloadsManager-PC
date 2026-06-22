# 從 extension-chrome-src 建置內建 Chrome 擴充（藍色圖示）

$ErrorActionPreference = "Stop"

$PcRoot = Split-Path $PSScriptRoot -Parent

$ChromeRoot = Join-Path $PcRoot "extension-chrome-src"

if (-not (Test-Path (Join-Path $ChromeRoot "manifest.json"))) {

    throw "Chrome 擴充原始碼不存在：$ChromeRoot"

}



$ExtId = "ggdnpjnbnfkefamaimapljjpfefmjjpf"

$Dest = Join-Path $PcRoot "extension\$ExtId"

if (Test-Path $Dest) {

    Remove-Item -Recurse -Force $Dest

}

New-Item -ItemType Directory -Path $Dest -Force | Out-Null



$dirs = @("background", "content", "lib", "offscreen", "sidepanel", "download", "_locales")

foreach ($d in $dirs) {

    $src = Join-Path $ChromeRoot $d

    if (Test-Path $src) {

        Copy-Item -Recurse $src (Join-Path $Dest $d)

    }

}



$iconSrc = Join-Path $ChromeRoot "icons"
$iconDest = Join-Path $Dest "icons"
New-Item -ItemType Directory -Path $iconDest -Force | Out-Null
foreach ($size in @(16, 48, 128)) {
    $srcFile = Join-Path $iconSrc "icon$size.png"
    if (Test-Path $srcFile) {
        Copy-Item $srcFile (Join-Path $iconDest "icon$size.png") -Force
    }
}



$manifestSrc = Join-Path $ChromeRoot "manifest.json"

$manifestDest = Join-Path $Dest "manifest.json"

Copy-Item $manifestSrc $manifestDest -Force

$py = Join-Path $PcRoot ".venv\Scripts\python.exe"

if (-not (Test-Path $py)) { $py = "python" }

& $py -c @"

import json

from pathlib import Path

p = Path(r'$manifestDest')

data = json.loads(p.read_text(encoding='utf-8'))

data['description'] = 'VDM_Bundled'

data['name'] = 'Video Downloads Manager'

data['key'] = 'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDEp8vN0Rk3mKxWqJ7sTfYhL2nP9uVcA4bR6jH8wZ1fG5tM3oQ7yU2iJ4kL6nO8pS0vX3cB9dF1gH5jK7mN9qR2tV4wY6zA8bC0eG2iK4mO6pS8uW0yZ2aD4fH6jL8nP0rT2vX4zB6dF8hJ0lN2pR4tV6xZ8bD0fH2jL4nP6qT8vX0zB2dF4hJ6lN8pR0tV2xZ4bD6fH8jL0nP2qR4tV6xZ8aC0eG2iK4mO6pS8uW0yZ2aD4fH6jL8nP0rT2vX4zB6dF8hJ0lN2pR4tV6xZ8bD0fH2jL4nP6qT8vX0zB2dF4hJ6lN8pR0tV2xZ4bD6fH8jL0nP2qR4tV6xZ8QIDAQAB'

p.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

"@

Write-Host "VDM Chrome extension ready: $Dest"

