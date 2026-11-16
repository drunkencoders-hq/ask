# Pester 5 tests for bootstrap.ps1. They dot-source the script (which then
# only defines functions) and mock winget, npm, PATH lookups and the
# platform check, so they run on any PowerShell (including pwsh on Linux in
# Docker). They do not prove behaviour on real Windows.

BeforeAll {
    . (Join-Path $PSScriptRoot '..' '..' 'bootstrap.ps1')
}

Describe 'argument and platform checks' {
    It 'refuses a missing hub address' {
        { Assert-HubUrl '' } | Should -Throw '*no hub address*'
    }
    It 'refuses a non-http hub address and shell metacharacters' {
        { Assert-HubUrl 'mini:8787' } | Should -Throw '*http*'
        { Assert-HubUrl 'http://mini:8787 & calc' } | Should -Throw '*http*'
    }
    It 'accepts a plain hub address' {
        { Assert-HubUrl 'http://mini:8787' } | Should -Not -Throw
        { Assert-HubUrl 'http://100.64.0.1:8787/' } | Should -Not -Throw
    }
    It 'refuses non-Windows hosts' {
        Mock Test-IsWindowsHost { $false }
        { Assert-Platform } | Should -Throw '*macOS*'
    }
    It 'stops with the App Installer hint when winget is missing' {
        Mock Find-Tool { $null }
        { Assert-Winget } | Should -Throw '*App Installer*'
    }
}

Describe 'winget package IDs' {
    It 'uses the IDs verified in microsoft/winget-pkgs' {
        $WingetIds.Node | Should -BeExactly 'OpenJS.NodeJS.LTS'
        $WingetIds.Git | Should -BeExactly 'Git.Git'
        $WingetIds.GitHub | Should -BeExactly 'GitHub.cli'
        $WingetIds.Tailscale | Should -BeExactly 'Tailscale.Tailscale'
    }
}

Describe 'Invoke-Main' {
    BeforeEach {
        $Hub = 'http://mini:8787'
        $DryRun = $false
        $script:installed = @{ 'winget.exe' = $true; 'node.exe' = $true; 'git.exe' = $true; 'gh.exe' = $true; 'npm.cmd' = $true; 'ask.cmd' = $true; 'tailscale.exe' = $true }
        $script:calls = [System.Collections.Generic.List[string]]::new()
        Mock Test-IsWindowsHost { $true }
        Mock Find-Tool { param($Name) if ($script:installed[$Name]) { "C:\tools\$Name" } else { $null } }
        Mock Find-Tailscale { if ($script:installed['tailscale.exe']) { 'C:\Program Files\Tailscale\tailscale.exe' } else { $null } }
        Mock Get-NodeMajor { if ($script:installed['node.exe']) { 22 } else { $null } }
        Mock Update-SessionPath {}
        Mock Invoke-Winget { param($Arguments) $script:calls.Add('winget ' + ($Arguments -join ' ')); 0 }
        Mock Invoke-NpmInstall { param($Source) $script:calls.Add("npm install -g $Source"); 0 }
        Mock Invoke-AskSetup { param($Url) $script:calls.Add("ask setup --hub $Url"); 0 }
        Mock Write-Host {}
    }

    It 'dry run on a bare machine plans every install and the hand-over, changes nothing, ends with DRY RUN OK' {
        $DryRun = $true
        foreach ($k in 'node.exe', 'git.exe', 'gh.exe', 'tailscale.exe', 'ask.cmd') { $script:installed[$k] = $false }
        $lines = [System.Collections.Generic.List[string]]::new()
        Mock Write-Host { param($Object) $lines.Add([string]$Object) }
        $code = Invoke-Main
        $code | Should -Be 0
        $script:calls.Count | Should -Be 0
        Should -Invoke Update-SessionPath -Times 0
        ($lines -join "`n") | Should -Match 'would run: winget install --id OpenJS.NodeJS.LTS --exact --source winget'
        ($lines -join "`n") | Should -Match 'would run: winget install --id Tailscale.Tailscale'
        ($lines -join "`n") | Should -Match 'would run: npm.cmd install -g git\+https://github.com/drunkencoders-hq/ask.git'
        ($lines -join "`n") | Should -Match 'would run: ask.cmd setup --hub http://mini:8787'
        $lines[-1] | Should -BeExactly 'DRY RUN OK: no changes made'
    }

    It 'installs only what is missing, refreshes PATH after each install, then hands over' {
        $script:installed['gh.exe'] = $false
        Mock Invoke-Winget { param($Arguments) $script:calls.Add('winget ' + ($Arguments -join ' ')); $script:installed['gh.exe'] = $true; 0 }
        $code = Invoke-Main
        $code | Should -Be 0
        @($script:calls | Where-Object { $_ -like 'winget*' }).Count | Should -Be 1
        $script:calls[0] | Should -Match '--id GitHub.cli'
        $script:calls | Should -Contain 'ask setup --hub http://mini:8787'
        Should -Invoke Update-SessionPath -Times 2
    }

    It 'is idempotent: a finished machine installs nothing and only updates ask' {
        $code = Invoke-Main
        $code | Should -Be 0
        @($script:calls | Where-Object { $_ -like 'winget*' }).Count | Should -Be 0
        $script:calls[0] | Should -BeExactly 'npm install -g git+https://github.com/drunkencoders-hq/ask.git'
    }

    It 'honours ASK_INSTALL_SOURCE' {
        $env:ASK_INSTALL_SOURCE = 'C:\src\ask'
        try { Invoke-Main | Out-Null } finally { Remove-Item Env:ASK_INSTALL_SOURCE }
        $script:calls[0] | Should -BeExactly 'npm install -g C:\src\ask'
    }

    It 'asks for a new window when a fresh install is still not on PATH' {
        $script:installed['git.exe'] = $false
        $lines = [System.Collections.Generic.List[string]]::new()
        Mock Write-Host { param($Object) $lines.Add([string]$Object) }
        $code = Invoke-Main
        $code | Should -Be 1
        ($lines -join "`n") | Should -Match 'FAILED: Git was installed but this window cannot see it yet. Open a new PowerShell window'
        $script:calls | Should -Not -Contain 'ask setup --hub http://mini:8787'
    }

    It 'fails with one line when winget fails' {
        $script:installed['node.exe'] = $false
        Mock Invoke-Winget { 5 }
        $lines = [System.Collections.Generic.List[string]]::new()
        Mock Write-Host { param($Object) $lines.Add([string]$Object) }
        (Invoke-Main) | Should -Be 1
        @($lines | Where-Object { $_ -like 'bootstrap: FAILED:*' }).Count | Should -Be 1
        ($lines -join "`n") | Should -Match 'winget could not install Node.js LTS \(OpenJS.NodeJS.LTS, exit 5\)'
    }

    It 'passes on a failing ask setup exit code' {
        Mock Invoke-AskSetup { 5 }
        (Invoke-Main) | Should -Be 5
    }

    It 'refuses outside Windows (e.g. WSL) before touching anything' {
        Mock Test-IsWindowsHost { $false }
        (Invoke-Main) | Should -Be 1
        $script:calls.Count | Should -Be 0
    }
}
