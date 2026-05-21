#!/usr/bin/env pwsh

# Toggle MeshInfo maintenance mode (PowerShell port of maintenance.sh).
#
# When enabled, Caddy serves public/maintenance/index.html (HTTP 503) for
# every request instead of proxying to the app -- useful while taking the
# backend or database down for an upgrade.
#
# Caddy checks the flag file per-request, so on/off takes effect on the
# very next request. No 'caddy reload' or container restart is needed.
#
# Usage:
#   scripts\maintenance.ps1 on        # show the maintenance page
#   scripts\maintenance.ps1 off       # back to normal
#   scripts\maintenance.ps1 status    # report current state (default)

param(
    [ValidateSet('on', 'off', 'status')]
    [string]$Action = 'status'
)

$ErrorActionPreference = 'Stop'

# Flag file lives in the dir bind-mounted into the caddy container.
$flag = Join-Path $PSScriptRoot '..\public\maintenance\ON'

switch ($Action) {
    'on' {
        if (-not (Test-Path $flag)) { New-Item -ItemType File -Path $flag | Out-Null }
        Write-Host 'Maintenance mode ENABLED  -- visitors now see the maintenance page.' -ForegroundColor Yellow
    }
    'off' {
        if (Test-Path $flag) { Remove-Item $flag }
        Write-Host 'Maintenance mode DISABLED -- site is live.' -ForegroundColor Green
    }
    'status' {
        if (Test-Path $flag) {
            Write-Host 'Maintenance mode is ON' -ForegroundColor Yellow
        }
        else {
            Write-Host 'Maintenance mode is OFF' -ForegroundColor Green
        }
    }
}
