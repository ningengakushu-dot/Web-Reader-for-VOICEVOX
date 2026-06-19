Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (git rev-parse --show-toplevel).Trim()
$flagPath = Join-Path $repoRoot '.codex\run-agent-loop.flag'
$flagDir = Split-Path -Parent $flagPath

New-Item -ItemType Directory -Force -Path $flagDir | Out-Null
Set-Content -LiteralPath $flagPath -Value "run" -Encoding UTF8

Write-Host "Agent loop trigger is armed."
Write-Host "The next Codex Stop hook will start scripts/agent-loop.ps1."
Write-Host "If this is the first run, open /hooks in Codex and trust the project hook."
