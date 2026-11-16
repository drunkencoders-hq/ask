# Item 5 checks, run inside mcr.microsoft.com/powershell (see README).
$ErrorActionPreference = 'Stop'
$src = Join-Path $PSScriptRoot '..' '..'
$script = Join-Path $src 'bootstrap.ps1'
Write-Host "PowerShell $($PSVersionTable.PSVersion) on $($PSVersionTable.OS)"

Write-Host "`n== Parser"
$tokens = $null; $errors = $null
[System.Management.Automation.Language.Parser]::ParseFile($script, [ref]$tokens, [ref]$errors) | Out-Null
Write-Host "parse errors: $($errors.Count)"
$errors | ForEach-Object { Write-Host "  $($_.Extent.StartLineNumber): $($_.Message)" }

Set-PSRepository PSGallery -InstallationPolicy Trusted
Install-Module Pester -RequiredVersion 5.7.1 -Scope CurrentUser -Force -SkipPublisherCheck
Install-Module PSScriptAnalyzer -RequiredVersion 1.24.0 -Scope CurrentUser -Force

Write-Host "`n== PSScriptAnalyzer 1.24.0 (all rules; compatibility with Windows PowerShell 5.1 on Windows)"
$settings = @{
    Rules = @{
        PSUseCompatibleSyntax   = @{ Enable = $true; TargetVersions = @('5.1', '7.4') }
        PSUseCompatibleCommands = @{ Enable = $true; TargetProfiles = @('win-48_x64_10.0.17763.0_5.1.17763.316_x64_4.0.30319.42000_framework') }
    }
}
$findings = Invoke-ScriptAnalyzer -Path $script -Settings $settings
$findings | Sort-Object Severity, Line | Format-Table Severity, RuleName, Line, Message -AutoSize -Wrap | Out-String -Width 200 | Write-Host
$errs = @($findings | Where-Object Severity -eq 'Error').Count
Write-Host "errors: $errs  warnings: $(@($findings | Where-Object Severity -eq 'Warning').Count)  information: $(@($findings | Where-Object Severity -eq 'Information').Count)"

Write-Host "`n== Pester 5.7.1"
$cfg = New-PesterConfiguration
$cfg.Run.Path = (Join-Path $src 'test' 'ps' 'bootstrap.Tests.ps1')
$cfg.Output.Verbosity = 'Detailed'
$cfg.Run.PassThru = $true
$r = Invoke-Pester -Configuration $cfg

Write-Host "`n== -DryRun with mocked tools"
& pwsh -NoProfile -File (Join-Path $src 'test' 'ps' 'dryrun-mocked.ps1')
$dry = $LASTEXITCODE

if ($errors.Count -or $errs -or $r.FailedCount -or $dry) { exit 1 }
Write-Host "`nALL POWERSHELL CHECKS PASSED"
