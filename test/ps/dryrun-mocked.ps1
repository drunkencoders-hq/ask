# Runs bootstrap.ps1's Invoke-Main with -DryRun on a non-Windows PowerShell
# (Docker), with the platform check and tool lookups replaced: a bare
# Windows machine that has winget and nothing else. Proves the dry-run path
# end to end; it is not a Windows run.
. (Join-Path $PSScriptRoot '..' '..' 'bootstrap.ps1')
$Hub = 'http://mini:8787'
$DryRun = [switch]::new($true)
function Test-IsWindowsHost { $true }
function Find-Tool([string]$Name) { if ($Name -eq 'winget.exe') { 'C:\Users\nora\AppData\Local\Microsoft\WindowsApps\winget.exe' } else { $null } }
function Find-Tailscale { $null }
function Get-NodeMajor { $null }
function Invoke-Winget { throw 'dry run must not call winget' }
function Invoke-NpmInstall { throw 'dry run must not call npm' }
function Invoke-AskSetup { throw 'dry run must not call ask setup' }
function Update-SessionPath { throw 'dry run must not touch PATH' }
$code = Invoke-Main
Write-Host "exit=$code"
exit $code
