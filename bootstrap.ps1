# drunkencoders bootstrap for Windows 10/11 (Windows PowerShell 5.1 or later).
#
#   & ([scriptblock]::Create((irm <bootstrap.windows>))) -Hub <hub_url> -Token <set-up token> [-Share <link>]
#
# Installs only what is missing (Node LTS, Git, GitHub CLI, Tailscale) with
# winget, installs or updates the `ask` tool, then hands over to
# `ask setup --hub <hub_url>`, which signs in, reports in to the hub, waits for
# registration, registers the MCP server, runs the standby check and sends a
# first test question. Safe to run again. -DryRun changes nothing.
# Does not need an elevated shell and does not change the execution policy.
# No secrets in here: the token comes from your Slack message, goes to
# `ask setup` through its environment only, and is never written or printed.

[CmdletBinding()]
param(
    [string]$Hub = '',
    [string]$Token = '',
    [string]$Share = '',
    [switch]$NoFirstQuestion,
    [switch]$DryRun
)

Set-StrictMode -Version 2.0

$Org = 'drunkencoders-hq'
$NodeMinMajor = 20
# The website starter (Astro) needs an even-numbered Node of at least this major.
$StarterNodeMinMajor = 22

# winget package IDs, checked against microsoft/winget-pkgs (manifests/<letter>/...).
$WingetIds = @{
    Node      = 'OpenJS.NodeJS.LTS'
    Git       = 'Git.Git'
    GitHub    = 'GitHub.cli'
    Tailscale = 'Tailscale.Tailscale'
}

function Get-AskSource {
    if ($env:ASK_INSTALL_SOURCE) { return $env:ASK_INSTALL_SOURCE }
    return "git+https://github.com/$Org/ask.git"
}

function Write-Step([string]$Text) { Write-Host $Text }

function Write-Plan([string]$Text) { Write-Host "  would run: $Text" }

$script:FailurePrefix = 'drunkencoders-bootstrap: '

function Stop-Bootstrap([string]$Message) {
    throw ($script:FailurePrefix + $Message)
}

function Test-IsWindowsHost {
    # $IsWindows does not exist in Windows PowerShell 5.1.
    if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) { return $false }
    if ($env:WSL_DISTRO_NAME) { return $false }
    return $true
}

function Assert-Platform {
    if (-not (Test-IsWindowsHost)) {
        Stop-Bootstrap 'this script is for Windows. On macOS, paste the Terminal command from your Slack DM instead (inside WSL, use Windows PowerShell, not WSL).'
    }
}

function Assert-HubUrl([string]$Url) {
    if (-not $Url) {
        Stop-Bootstrap 'no hub address: paste the full command from your Slack DM (it ends with -Hub <address>).'
    }
    if ($Url -notmatch '^https?://[A-Za-z0-9.\-\[\]:]+(/[A-Za-z0-9._~/\-]*)?$') {
        Stop-Bootstrap "-Hub must be a plain http:// or https:// address such as http://hub.invalid:8787 (got: $Url)."
    }
}

function Assert-ShareUrl([string]$Url) {
    if ($Url -and $Url -notmatch '^https://\S+$') {
        Stop-Bootstrap '-Share must be an https:// link: paste the full command from your Slack message.'
    }
}

# Progress for the hub: one line per step, handed to `ask setup`, which sends
# them once the hub is reachable. Never contains the token.
$script:Queue = $null
function Add-Report([string]$Step, [string]$Status, [string]$Note = '') {
    if ($DryRun) {
        $suffix = ''
        if ($Note) { $suffix = " ($Note)" }
        Write-Host "  would report: $Step $Status$suffix"
        return
    }
    if (-not $script:Queue) { return }
    $epoch = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    Add-Content -LiteralPath $script:Queue -Value ("{0}`t{1}`t{2}`t{3}" -f $epoch, $Step, $Status, $Note) -Encoding UTF8
}

function Update-SessionPath {
    # A freshly installed tool is not on PATH in this session; reload it from the machine and user environment.
    $machine = [System.Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [System.Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = (@($machine, $user) | Where-Object { $_ }) -join ';'
}

function Find-Tool([string]$Name) {
    $cmd = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd) { return $cmd.Source }
    return $null
}

function Find-Tailscale {
    $onPath = Find-Tool 'tailscale.exe'
    if ($onPath) { return $onPath }
    foreach ($dir in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
        if ($dir) {
            $candidate = Join-Path $dir 'Tailscale\tailscale.exe'
            if (Test-Path -LiteralPath $candidate) { return $candidate }
        }
    }
    return $null
}

function Get-NodeMajor {
    $node = Find-Tool 'node.exe'
    if (-not $node) { return $null }
    $v = & $node --version 2>$null
    if ($v -match '^v(\d+)\.') { return [int]$Matches[1] }
    return $null
}

function Get-NodeVersion([int]$Major) {
    # Full version for the warning; falls back to the major when node cannot be asked.
    try {
        $node = Find-Tool 'node.exe'
        if ($node) {
            $v = (& $node --version 2>$null | Select-Object -First 1)
            if ($v -match '^v\d+\.\d+') { return [string]$v }
        }
    }
    catch {
        Write-Verbose 'node --version did not answer'
    }
    return "v$Major"
}

# One warning for a Node that is fine for ask but not for the website starter.
# Same wording as `ask doctor`. The existing Node is never replaced.
function Write-StarterNodeWarning([int]$Major) {
    $even = ($Major % 2) -eq 0
    if ($even -and $Major -ge $StarterNodeMinMajor) { return $false }
    $v = Get-NodeVersion $Major
    Write-Host ("warn Node $v works for ``ask``, but the website starter needs an even-numbered Node $StarterNodeMinMajor or newer. To install one (your current Node is left as it is): winget install --id " + $WingetIds.Node + ' --exact')
    return $true
}

function Assert-Winget {
    if (-not (Find-Tool 'winget.exe')) {
        Stop-Bootstrap 'winget is missing. Install "App Installer" from the Microsoft Store (https://apps.microsoft.com/detail/9NBLGGH4NNS1), then paste the same command again.'
    }
}

# Native calls are wrapped so tests can mock them; output goes to the console, not the pipeline.
function Invoke-Winget([string[]]$Arguments) {
    & winget.exe @Arguments | Out-Host
    return $LASTEXITCODE
}

function Invoke-NpmInstall([string]$Source) {
    & npm.cmd install -g $Source | Out-Host
    return $LASTEXITCODE
}

function Install-WingetPackage([string]$Id, [string]$Label) {
    $wingetArgs = @('install', '--id', $Id, '--exact', '--source', 'winget', '--accept-package-agreements', '--accept-source-agreements')
    if ($DryRun) {
        Write-Plan ("winget " + ($wingetArgs -join ' '))
        return
    }
    Write-Step "  installing $Label with winget ($Id). If Windows asks for permission (UAC), click Yes."
    $code = Invoke-Winget $wingetArgs
    # -1978335189 (0x8A15002B): no applicable upgrade, i.e. already installed.
    if ($code -ne 0 -and $code -ne -1978335189) {
        Stop-Bootstrap "winget could not install $Label ($Id, exit $code). Fix what winget reported, then paste the same command again."
    }
    Update-SessionPath
}

function Assert-OnPathAfterInstall([string]$Label, [bool]$Found) {
    if (-not $DryRun -and -not $Found) {
        Stop-Bootstrap "$Label was installed but this window cannot see it yet. Open a new PowerShell window and paste the same command again (it is safe to repeat)."
    }
}

function Confirm-Node {
    $major = Get-NodeMajor
    if ($null -ne $major -and $major -ge $NodeMinMajor) {
        Write-Step "ok   Node v$major"
        if (Write-StarterNodeWarning $major) {
            Add-Report 'node' 'skipped' "already installed (v$major; website starter needs even 22+)"
        }
        else {
            Add-Report 'node' 'skipped' 'already installed'
        }
        return
    }
    if ($null -ne $major) { Write-Step "--   Node v$major is older than $NodeMinMajor." } else { Write-Step '--   Node is not installed.' }
    Install-WingetPackage $WingetIds.Node 'Node.js LTS'
    $after = Get-NodeMajor
    Assert-OnPathAfterInstall 'Node.js' ($null -ne $after -and $after -ge $NodeMinMajor)
    Add-Report 'node' 'done' 'installed'
}

function Confirm-Git {
    if (Find-Tool 'git.exe') { Write-Step 'ok   git'; Add-Report 'git' 'skipped' 'already installed'; return }
    Write-Step '--   git is not installed.'
    Install-WingetPackage $WingetIds.Git 'Git'
    Assert-OnPathAfterInstall 'Git' ([bool](Find-Tool 'git.exe'))
    Add-Report 'git' 'done' 'installed'
}

function Confirm-GitHubCli {
    if (Find-Tool 'gh.exe') { Write-Step 'ok   GitHub CLI'; Add-Report 'gh' 'skipped' 'already installed'; return }
    Write-Step '--   GitHub CLI (gh) is not installed.'
    Install-WingetPackage $WingetIds.GitHub 'GitHub CLI'
    Assert-OnPathAfterInstall 'GitHub CLI' ([bool](Find-Tool 'gh.exe'))
    Add-Report 'gh' 'done' 'installed'
}

function Confirm-Tailscale {
    if (Find-Tailscale) { Write-Step 'ok   Tailscale'; Add-Report 'tailscale' 'skipped' 'already installed'; return }
    Write-Step '--   Tailscale is not installed. Its installer needs administrator permission: Windows will ask (UAC).'
    Install-WingetPackage $WingetIds.Tailscale 'Tailscale'
    Assert-OnPathAfterInstall 'Tailscale' ([bool](Find-Tailscale))
    Add-Report 'tailscale' 'done' 'installed'
}

function Confirm-Ask {
    $source = Get-AskSource
    $present = [bool](Find-Tool 'ask.cmd')
    if ($present) { Write-Step "ok   ask is installed; updating it from $source" } else { Write-Step '--   ask is not installed.' }
    if ($DryRun) {
        Write-Plan "npm.cmd install -g $source"
        if ($present) { Add-Report 'ask' 'skipped' 'already installed; updated' } else { Add-Report 'ask' 'done' 'installed' }
        return
    }
    if (-not (Find-Tool 'npm.cmd')) {
        Stop-Bootstrap 'npm is not available in this window. Open a new PowerShell window and paste the same command again.'
    }
    $code = Invoke-NpmInstall $source
    if ($code -ne 0) {
        Stop-Bootstrap "could not install ask from $source (npm exit $code). Check your internet connection, then paste the same command again."
    }
    Update-SessionPath
    Assert-OnPathAfterInstall 'ask' ([bool](Find-Tool 'ask.cmd'))
    if ($present) { Add-Report 'ask' 'skipped' 'already installed; updated' } else { Add-Report 'ask' 'done' 'installed' }
}

function Get-SetupArgs([string]$Url) {
    $a = "setup --hub $Url"
    if ($NoFirstQuestion) { $a += ' --no-first-question' }
    return $a
}

# What the hand-over looks like on screen: the token and the share link masked.
function Get-MaskedHandOver([string]$Url) {
    $m = "ask setup --hub $Url"
    if ($Token) { $m += ' --token ********' }
    if ($Share) { $m += ' --share <link from your message>' }
    if ($NoFirstQuestion) { $m += ' --no-first-question' }
    return $m
}

function Invoke-AskSetup([string]$Url) {
    # The token and the share link go to `ask setup` through its environment
    # only (not its command line), and are removed from this session afterwards.
    $env:ASK_ONBOARDING_TOKEN = $Token
    $env:ASK_ONBOARDING_SHARE = $Share
    if ($script:Queue) { $env:ASK_ONBOARDING_QUEUE = $script:Queue }
    try {
        $p = Start-Process -FilePath $env:ComSpec -ArgumentList ("/d /c ask.cmd " + (Get-SetupArgs $Url)) -NoNewWindow -Wait -PassThru
        return $p.ExitCode
    }
    finally {
        Remove-Item Env:\ASK_ONBOARDING_TOKEN, Env:\ASK_ONBOARDING_SHARE, Env:\ASK_ONBOARDING_QUEUE -ErrorAction SilentlyContinue
    }
}

function Invoke-HandOver([string]$Url) {
    Write-Step ''
    Write-Step ("== Handing over to: " + (Get-MaskedHandOver $Url))
    if ($DryRun) {
        Write-Plan ((Get-MaskedHandOver $Url).Replace('ask setup', 'ask.cmd setup') + '   (signs in to Tailscale and GitHub, reports in, waits for registration in Slack, registers the MCP server, runs the standby check)')
        Write-Step ''
        Write-Step 'DRY RUN OK: no changes made'
        return 0
    }
    # Run attached to this console (not through the pipeline) so the sign-in
    # prompts of tailscale and gh stay interactive. $Url was validated above.
    $code = Invoke-AskSetup $Url
    if ($code -ne 0) {
        Write-Host "bootstrap: FAILED: ask setup exited $code (see the message above). Fix it, then paste the same command again; it is safe to repeat." -ForegroundColor Red
        return $code
    }
    Write-Step "bootstrap: done. Run 'ask doctor' at any time to re-check this machine."
    return 0
}

function Invoke-Main {
    try {
        Assert-Platform
        Assert-HubUrl $Hub
        Assert-ShareUrl $Share
        if ($DryRun) { Write-Step 'drunkencoders bootstrap (dry run: nothing will be changed)' } else { Write-Step 'drunkencoders bootstrap' }
        Write-Step "hub: $Hub"
        Write-Step ("ask source: " + (Get-AskSource))
        Write-Step ''
        if (-not $DryRun -and $Token) { $script:Queue = [System.IO.Path]::GetTempFileName() }
        Assert-Winget
        Confirm-Node
        Confirm-Git
        Confirm-GitHubCli
        Confirm-Tailscale
        Confirm-Ask
        return (Invoke-HandOver $Hub)
    }
    catch {
        $message = $_.Exception.Message
        if ($message.StartsWith($script:FailurePrefix)) { $message = $message.Substring($script:FailurePrefix.Length) }
        else { $message = "unexpected error: $message. Paste the same command again; if it repeats, send the output of 'ask doctor' to Jose." }
        Write-Host ("bootstrap: FAILED: " + $message) -ForegroundColor Red
        return 1
    }
    finally {
        if ($script:Queue) { Remove-Item -LiteralPath $script:Queue -Force -ErrorAction SilentlyContinue }
    }
}

# Dot-sourcing (`. ./bootstrap.ps1`, used by the Pester tests) only defines the functions.
if ($MyInvocation.InvocationName -ne '.') {
    $exitCode = Invoke-Main
    if ($PSCommandPath) {
        exit $exitCode
    }
    # Pasted as a scriptblock: do not close the user's window; report through $LASTEXITCODE.
    $global:LASTEXITCODE = $exitCode
}
