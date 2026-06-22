param(
    [string]$Message = ""
)

$root = Split-Path -Parent $PSScriptRoot
Push-Location $root

try {
    if (-not (Test-Path .git)) {
        git init | Out-Null
        Write-Host "Initialized git repository in $root"
    }

    git add -A
    $changes = git status --porcelain
    if (-not $changes) {
        Write-Host "No changes to backup."
        return
    }

    $ts = Get-Date -Format "yyyyMMdd_HHmmss"
    $commitMsg = if ($Message) { "backup: $ts - $Message" } else { "backup: $ts" }

    git -c user.name="VDM Backup" -c user.email="vdm-backup@local" commit -m $commitMsg
    $hash = git rev-parse --short HEAD
    Write-Host "Git backup: $commitMsg ($hash)"
}
finally {
    Pop-Location
}
