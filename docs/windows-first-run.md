# Windows: what to watch on the first real run

Nothing in this repo has been run on real Windows yet. The first real run
is a teammate's onboarding (brief 08, phase B). Everything below was
written and tested on a Mac: Node tests simulate Windows paths, and the
PowerShell script was parsed, linted and Pester-tested on PowerShell 7
(Linux, Docker) with winget, npm and tailscale mocked. Windows
PowerShell 5.1, winget, UAC and the npm shims were never exercised.

## The command

In a normal (not "Run as administrator") **Windows PowerShell** window:

```powershell
& ([scriptblock]::Create((irm <bootstrap.windows>))) -Hub http://<mini>:8787
```

Add `-DryRun` first to see the plan without changing anything.

## Collect diagnostics

If anything fails, run this in the same window and send Jose the output
(it changes nothing):

```powershell
ask doctor
```

If `ask` itself is not found yet, send the bootstrap's last 30 lines and
the output of `winget --version; node --version; npm.cmd prefix -g; $env:Path`.

## Likely failure points, in order

1. **winget missing or old.** The script stops and points to "App
   Installer" in the Microsoft Store. On Windows 10 machines that were
   never updated, winget may exist but fail on the first `source update`.
   Running `winget source reset --force` as admin is the usual fix.
2. **winget IDs.** `OpenJS.NodeJS.LTS`, `Git.Git`, `GitHub.cli`,
   `Tailscale.Tailscale`, checked against microsoft/winget-pkgs on
   2026-11-16. Watch for "No package found matching input criteria". If
   it appears, the ID has changed. Check with `winget search <name>` and
   update `$WingetIds` in `bootstrap.ps1`.
3. **UAC.** Node (MSI), Git and Tailscale install machine-wide and raise a
   UAC prompt. The script says so before each one. If the user clicks No,
   winget returns an error and the script stops with one line. Pasting
   the command again is safe.
4. **PATH refresh.** After each install the script reloads `Path` from the
   machine and user environment. If a tool is still not found, the script
   stops and asks for a new PowerShell window and the same command again.
   Expect this at least once on a bare machine. Watch whether it happens
   every time: that would mean the refresh is not picking something up
   (e.g. npm's `%APPDATA%\npm` is added to the *user* Path only by the
   Node installer on first run).
5. **`.cmd` shims.** `npm` and `ask` are `npm.cmd` and `ask.cmd`. The
   script calls them by those names. `ask setup` launches `claude.cmd`
   and other npm-installed assistant CLIs through `cmd.exe` (Node needs
   `shell: true` for `.cmd` since the April 2024 security release).
   Watch that `claude mcp add`, `gemini mcp add` and `codex mcp add`
   succeed. Arguments with spaces (`C:\Program Files\nodejs\node.exe`)
   are quoted.
6. **MCP launch command.** On Windows we register
   `<node.exe> <%APPDATA%\npm\node_modules\drunkencoders-ask\src\cli.js> mcp`
   instead of a bare `ask`, because tools that spawn without a shell cannot
   start `ask.cmd`. Check in each assistant that the `ask` server shows as
   connected. If Node is later reinstalled to a different folder, run
   `ask setup` again.
7. **Tailscale sign-in.** `ask setup` runs `tailscale up` for the
   sign-in. On Windows that may need the tray app instead. If it cannot
   finish, setup says "click the Tailscale icon in the taskbar tray and
   choose Log in" and waits up to 5 minutes. Check that `tailscale.exe`
   is found (PATH, then `C:\Program Files\Tailscale\tailscale.exe`; the
   exact file name in that folder was not confirmed from docs).
8. **gh sign-in.** `gh auth login` runs in the same console. The console
   stays interactive because the hand-over uses
   `Start-Process -NoNewWindow -Wait` rather than the pipeline. Confirm
   that the prompts appear and accept input.
9. **Exit codes in a pasted scriptblock.** The script does not call `exit`
   when pasted (that would close the window). It sets `$LASTEXITCODE`
   instead. Check `$LASTEXITCODE` after a failure.
10. **Encoding.** Messages contain `…` and `—`. Old console code pages may
    show them garbled. That is cosmetic. Answer text is UTF-8 from the
    hub.

## Done looks like

- `Standby verified: <teammate> via http://<mini>:8787` printed by setup,
  and a matching "Standby verified: … win32 …" line in `#runner`.
- `ask doctor` prints `ok` on every line.
