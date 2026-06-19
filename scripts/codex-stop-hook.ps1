Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-HookJson {
    param([string]$Message)
    $payload = @{
        continue = $true
        systemMessage = $Message
    }
    $payload | ConvertTo-Json -Compress
}

try {
    $repoRoot = (git rev-parse --show-toplevel 2>$null).Trim()
    if (-not $repoRoot) {
        exit 0
    }

    $flagPath = Join-Path $repoRoot '.codex\run-agent-loop.flag'
    if (-not (Test-Path -LiteralPath $flagPath)) {
        exit 0
    }

    Remove-Item -LiteralPath $flagPath -Force

    $logDir = Join-Path $repoRoot '.codex\agent-loop'
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    $hookLog = Join-Path $logDir 'hook-launch.out.log'
    $hookErrorLog = Join-Path $logDir 'hook-launch.err.log'
    $agentScript = Join-Path $repoRoot 'scripts\agent-loop.ps1'
    $taskFile = Join-Path $repoRoot 'docs\agent-tasks\shift-alt-u-shortcut.md'

    $arguments = @(
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', "`"$agentScript`"",
        '-TaskFile', "`"$taskFile`"",
        '-FromHook'
    )

    Start-Process -FilePath 'powershell.exe' `
        -ArgumentList $arguments `
        -WorkingDirectory $repoRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput $hookLog `
        -RedirectStandardError $hookErrorLog

    Write-HookJson "Agent loop started in background. Log: $hookLog"
} catch {
    Write-HookJson "Agent loop hook failed: $($_.Exception.Message)"
}
