# 建置整合版內建擴充（PC 推送 + 擴充下載）
$ErrorActionPreference = "Stop"
$Scripts = Split-Path $MyInvocation.MyCommand.Path -Parent
& (Join-Path $Scripts "prepare_chrome_extension.ps1")
