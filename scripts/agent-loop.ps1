param(
    [string]$TaskFile = "docs\agent-tasks\shift-alt-u-shortcut.md",
    [string]$BranchName = "fix/shortcut-alt-shift-u",
    [string]$BaseBranch = "main",
    [int]$MaxIterations = 3,
    [switch]$FromHook,
    [switch]$AutoCommit,
    [switch]$AutoPush
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Require-Command {
    param([string]$Name)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command not found: $Name"
    }
}

function Invoke-LoggedCommand {
    param(
        [string]$FilePath,
        [string[]]$Arguments,
        [string]$LogPath,
        [switch]$AllowFailure
    )

    $output = & $FilePath @Arguments 2>&1
    $exitCode = $LASTEXITCODE
    $output | Out-File -LiteralPath $LogPath -Encoding UTF8

    if ($exitCode -ne 0 -and -not $AllowFailure) {
        throw "$FilePath failed with exit code $exitCode. See $LogPath"
    }

    return @{
        ExitCode = $exitCode
        Output = ($output -join [Environment]::NewLine)
    }
}

function Run-Verification {
    param([string]$LogPath)

    $commands = @(
        @{ File = "node"; Args = @("-e", "JSON.parse(require('fs').readFileSync('manifest.json','utf8')); console.log('manifest json ok')") },
        @{ File = "node"; Args = @("--check", "background.js") },
        @{ File = "node"; Args = @("--check", "content.js") },
        @{ File = "node"; Args = @("--check", "offscreen.js") },
        @{ File = "node"; Args = @("--check", "options.js") },
        @{ File = "git"; Args = @("diff", "--check") }
    )

    $allOutput = New-Object System.Collections.Generic.List[string]
    foreach ($cmd in $commands) {
        $line = ">> $($cmd.File) $($cmd.Args -join ' ')"
        $allOutput.Add($line)
        $result = & $cmd.File @($cmd.Args) 2>&1
        $exitCode = $LASTEXITCODE
        if ($result) {
            foreach ($item in $result) {
                $allOutput.Add([string]$item)
            }
        }
        if ($exitCode -ne 0) {
            $allOutput | Out-File -LiteralPath $LogPath -Encoding UTF8
            return $false
        }
    }

    $allOutput | Out-File -LiteralPath $LogPath -Encoding UTF8
    return $true
}

function Get-ReviewVerdict {
    param([string]$ReviewText)

    if ($ReviewText -match "(?m)^VERDICT:\s*PASS\b") {
        return "PASS"
    }
    if ($ReviewText -match "(?m)^VERDICT:\s*REVISE\b") {
        return "REVISE"
    }
    return "REVISE"
}

Require-Command git
Require-Command node
Require-Command claude
Require-Command codex

$repoRoot = (git rev-parse --show-toplevel).Trim()
Set-Location $repoRoot

$taskPath = if ([System.IO.Path]::IsPathRooted($TaskFile)) { $TaskFile } else { Join-Path $repoRoot $TaskFile }
if (-not (Test-Path -LiteralPath $taskPath)) {
    throw "Task file not found: $taskPath"
}

$logRoot = Join-Path $repoRoot ".codex\agent-loop"
New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$runDir = Join-Path $logRoot $timestamp
New-Item -ItemType Directory -Force -Path $runDir | Out-Null

$currentBranch = (git branch --show-current).Trim()
if ($currentBranch -ne $BranchName) {
    $branches = git branch --list $BranchName
    if ($branches) {
        git switch $BranchName | Out-Null
    } else {
        git switch -c $BranchName | Out-Null
    }
}

$taskText = Get-Content -Raw -LiteralPath $taskPath
$previousReview = ""
$completed = $false

for ($i = 1; $i -le $MaxIterations; $i++) {
    $iterationDir = Join-Path $runDir ("iteration-" + $i)
    New-Item -ItemType Directory -Force -Path $iterationDir | Out-Null

    $claudePrompt = @"
You are the implementation worker for this repository.
Follow CLAUDE.md and the task below.
Do not commit, push, merge, or revert unrelated user changes.
Keep the patch narrow.

TASK:
$taskText

PREVIOUS CODEX REVIEW:
$previousReview
"@

    $promptPath = Join-Path $iterationDir "claude-prompt.md"
    $claudeLog = Join-Path $iterationDir "claude-output.txt"
    $verifyLog = Join-Path $iterationDir "verification.txt"
    $reviewPromptPath = Join-Path $iterationDir "codex-review-prompt.md"
    $reviewOutputPath = Join-Path $iterationDir "codex-review.txt"

    Set-Content -LiteralPath $promptPath -Value $claudePrompt -Encoding UTF8

    Invoke-LoggedCommand `
        -FilePath "claude" `
        -Arguments @("-p", $claudePrompt, "--allowedTools", "Read,Edit,MultiEdit,Write,Bash", "--output-format", "text") `
        -LogPath $claudeLog | Out-Null

    $verificationPassed = Run-Verification -LogPath $verifyLog

    $reviewPrompt = @"
You are Codex acting only as a code reviewer.
Do not edit files.
Review the uncommitted diff for this task:

$taskText

Verification passed: $verificationPassed
Verification log path: $verifyLog

Return the first line exactly as one of:
VERDICT: PASS
VERDICT: REVISE

Use PASS only if there are no actionable correctness, regression, or verification issues.
If REVISE, list concrete issues and exact files/lines when possible.
"@

    Set-Content -LiteralPath $reviewPromptPath -Value $reviewPrompt -Encoding UTF8

    Invoke-LoggedCommand `
        -FilePath "codex" `
        -Arguments @("--ask-for-approval", "never", "exec", "--disable", "hooks", "--sandbox", "read-only", "-C", $repoRoot, "-o", $reviewOutputPath, $reviewPrompt) `
        -LogPath (Join-Path $iterationDir "codex-exec-events.txt") `
        -AllowFailure | Out-Null

    $reviewText = if (Test-Path -LiteralPath $reviewOutputPath) {
        Get-Content -Raw -LiteralPath $reviewOutputPath
    } else {
        "VERDICT: REVISE`nCodex review output was not created."
    }

    $verdict = Get-ReviewVerdict -ReviewText $reviewText
    $previousReview = $reviewText

    if ($verificationPassed -and $verdict -eq "PASS") {
        $completed = $true
        break
    }
}

$summaryPath = Join-Path $runDir "summary.txt"
$status = if ($completed) { "PASS" } else { "INCOMPLETE" }
$diffStat = git diff --stat

@"
Status: $status
Run directory: $runDir
Branch: $((git branch --show-current).Trim())

Diff stat:
$diffStat
"@ | Out-File -LiteralPath $summaryPath -Encoding UTF8

if ($completed -and $AutoCommit) {
    git add -A
    git commit -m "fix: improve shortcut text reading startup"
}

if ($completed -and $AutoPush) {
    git push -u origin $((git branch --show-current).Trim())
}

Write-Host "Agent loop status: $status"
Write-Host "Summary: $summaryPath"
