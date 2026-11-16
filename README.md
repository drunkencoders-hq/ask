# ask

Ask the project's owner a question from any AI session and get the answer
back. `ask` sends the question to the drunkencoders hub (on the team's Mac
mini, over Tailscale); the hub shows it to the owner in Slack; the owner's
answer comes back to the waiting `ask` call, which prints it and sends a
receipt to prove it arrived.

One implementation, two front ends: a plain CLI and a stdio MCP server
(`ask mcp`). Nothing runs in the background between calls. macOS and
Windows. Node ≥ 20, no build step.

## Install

Newcomers get one command by Slack DM when they join (or by `/onboard`).
It carries the hub address, a one-time set-up token and, when needed, a
Tailscale share link; none of these are in this repo:

- macOS (Terminal): `curl -fsSL <bootstrap.macos> | bash -s -- --hub <hub_url> --token <token> [--share <link>]`
- Windows (PowerShell): `& ([scriptblock]::Create((irm <bootstrap.windows>))) -Hub <hub_url> -Token <token> [-Share <link>]`

Add `--dry-run` / `-DryRun` to see the plan without changing anything. Both
are safe to run again. A teammate the hub already knows can leave out the
token. By hand: `npm install -g git+https://github.com/drunkencoders-hq/ask.git`,
then `ask setup --hub <hub_url> [--token <token>]`.

## What the bootstrap does to your machine

### macOS (`bootstrap.sh`): no questions asked

You approve only **macOS's own prompts** (your Mac password, and allowing
Tailscale's VPN configuration) and **two sign-ins in your browser**
(GitHub, then Tailscale). The script types, reads and stores no password.

1. Refuses to run as root or on anything but macOS.
2. Installs **only what is missing**, in this order:
   1. Homebrew, with its official installer in non-interactive mode. That
      mode cannot ask for your password itself, so only when Homebrew is
      missing the script runs `sudo -v` once, just before the installer:
      macOS asks for your Mac password in Terminal. The script never sees
      or stores the password and runs nothing else with sudo (decision 96).
      If your account is not an administrator it stops before that, with
      one line saying so.
   2. `git` (Homebrew). Apple's `/usr/bin/git` counts only when the Command
      Line Tools are installed, so their install dialog never pops up.
   3. Node, only if it is missing or older than 20: the newest
      **even-numbered** Node, an LTS line (today Homebrew's `node`, which is
      Node 26). The team's website starter (Astro) needs an even-numbered
      Node 22 or newer, and Homebrew's plain `node` formula follows Node's
      newest release, which is an odd-numbered, short-lived line for half of
      every year. When `node` is itself odd, the script installs the newest
      `node@<even>` formula that exists and links it into Homebrew's `bin`
      (already first on your `PATH`; no shell profile is edited). If
      Homebrew cannot be asked or no such formula exists, it uses the pinned
      fallback **`node@24`** (a constant at the top of `bootstrap.sh`, also in
      `src/setup/nodeversion.js`). A Node you already have (20 or newer) is
      never replaced, unlinked or reordered: if it is odd-numbered or older
      than 22 you get one warning with the command that installs a suitable
      one (naming nvm, fnm, asdf or Volta when one supplies it), and the
      set-up carries on. `ask doctor` shows the same warning, and
      `ask doctor --json` carries it as `level: "warn"`; it does not change
      its exit code.
   4. `gh`, the GitHub CLI (Homebrew).
   5. The Tailscale app (`tailscale-app` cask; macOS asks for your password
      and, on first start, to allow a VPN configuration).
   6. `ask`, with `npm install -g` from the public `drunkencoders-hq/ask`
      repo (an existing `ask` is updated).
   7. Claude Code (`claude-code` cask), only if none of Claude Code, Cursor
      or Codex CLI is installed.
3. Runs `ask setup --hub <hub_url>` with the token, which:
   - signs you in to GitHub: `gh auth login --web --clipboard` without a
     terminal, so gh asks nothing. gh puts the one-time code (and nothing
     else) on your **clipboard** and setup also prints it, in case copying
     fails; the code is not written to any file or report.
     github.com/login/device opens in your browser; paste the code there.
     Then `gh auth setup-git`, and your GitHub login is read with
     `gh api user`;
   - starts the Tailscale app and signs you in (`tailscale login`, the
     sign-in page opens in your browser);
   - waits for the hub. If it is not reachable and your message had a share
     link, it opens that link once so you can accept the Mac mini's share.
     It gives up after 15 minutes (exit 4; paste the command again);
   - asks the hub `whoami` first: if it already knows you (the command
     pasted again after registration), registration is skipped;
   - otherwise reports who you are (below) and waits until the approver
     confirms your registration in Slack ("Waiting for <approver> to
     confirm in Slack…"; refused, or the command expired: exit 5, ask for
     a new command with `/onboard`). If the hub asks it to slow down (429),
     it waits as long as the hub says and carries on;
   - writes `~/.config/drunkencoders/ask.json` containing only `hub_url`;
   - registers the `ask` MCP server with Claude Code, Cursor, Codex CLI and
     Gemini CLI if they are installed (each tool's own `mcp add` command;
     for Cursor an edit of `~/.cursor/mcp.json` after a timestamped
     backup), and prints a snippet for `AGENTS.md` for other AI tools;
   - sends a standby test; "Standby verified" appears in `#runner`;
   - reports `ready`, then sends a first test question to your mentor
     ("Set-up test from <your Mac's name>: this is my first question through
     `ask`. Can you see it?") and shows the answer if it comes within 10
     minutes (otherwise `ask --resume` collects it later). Leave it out with
     `--no-first-question`.

**What is sent to the hub**, and nothing else about your machine:

- `whoami` (no body): does the hub already know this Mac?
- `hello`: the ask version, your Mac's host name and OS;
- `identity`: your GitHub login, OS, host name, and which AI assistants are
  installed (for example `claude-code`). Your Slack identity comes from the
  token and your Tailscale login from the connection;
- one progress report per step, posted as a short line in your mentoring
  channel: step (`homebrew`, `git`, `node`, `gh`, `tailscale`, `ask`,
  `assistant`, `github-sign-in`, `tailscale-sign-in`, `hub-reached`,
  `identity`, `registered`, `mcp`, `standby`, `ready`), status (`started`,
  `done`, `blocked`, `skipped`) and a short note (for example "installed",
  or the time of a step done before the hub was reachable). Steps the
  script does before that are kept in a temporary file (no token in it),
  sent in order once the hub answers, and the file is deleted. A report
  that fails is printed and never stops the set-up;
- the standby test and the first question, as above.

The token is passed to `ask setup` through its environment, held in
memory, never written to disk (not in `ask.json`, the pending-answers file
or the step file), never printed, and not passed on to any other program.

### Windows (`bootstrap.ps1`)

1. Refuses to run outside Windows (including inside WSL). It needs no
   administrator window and does not change the execution policy.
2. Needs `winget` ("App Installer"). If it is missing, it stops and tells
   you where to get it.
3. Installs with winget **only what is missing**: `OpenJS.NodeJS.LTS`,
   `Git.Git`, `GitHub.cli`, `Tailscale.Tailscale`. Windows shows a UAC
   prompt for installers that need it; the script says so first. If a new
   tool is not visible yet, it asks you to open a new PowerShell window
   and paste the same command again.
   (`OpenJS.NodeJS.LTS` is already an even-numbered LTS line.) A Node you
   already have is never replaced; if it is odd-numbered or older than 22 the
   script prints the same one-line warning as `ask doctor`, with
   `winget install --id OpenJS.NodeJS.LTS --exact`.
4. Installs or updates `ask` with `npm.cmd install -g`.
5. Runs `ask setup --hub <hub_url>`, with `-Token`/`-Share` passed to it
   through its environment (same steps as on macOS; Tailscale sign-in may
   instead need the tray icon's "Log in"). Windows still installs without
   per-tool questions but is not hands-free in the macOS sense: UAC prompts
   and a possible new-window restart remain. The config is
   `%APPDATA%\drunkencoders\ask.json`. MCP entries point at
   `node.exe …\drunkencoders-ask\src\cli.js mcp`, because some tools
   cannot start npm's `ask.cmd`.

Neither script adds a background service, scheduled task, login item,
startup entry or auto-update, and neither edits your shell profile
(package managers may add themselves to `PATH`). The only things written
are the hub address and the MCP entries (plus, during set-up, the step file
in your temp folder, deleted at the end). No tokens or keys are written.

### Uninstall

```
ask setup --unregister        # removes the MCP entries and the config file
npm uninstall -g drunkencoders-ask
```

Node, git, gh and Tailscale stay installed. Remove them with Homebrew or
winget if you no longer want them. Backups named `*.bak-<timestamp>` next
to an edited assistant config can be deleted.

## Setup commands

```
ask setup --hub <url>    configure, sign in, register MCP, run the standby check
ask setup --hub <url> --token <t> [--share <link>] [--no-first-question]
                         the same for a newcomer: report in, wait for registration
                         in Slack, then `ready` and a first test question
ask setup --unregister   remove the MCP entries and the config file
ask doctor               read-only checks, one line each; non-zero if any fail
                         (`--json`: the same as one JSON object; a warning has "level": "warn")
ask standby              standby test through the hub; prints "Standby verified: <you> via <hub>"
```

`ask setup` exits non-zero when any step fails: Tailscale not signed in,
the hub not answering, `gh` not signed in, the hub not knowing this
machine (`unknown_caller`, the message shows your Tailscale login to send to
Jose), an installed assistant that could not be registered, or a standby
check without a receipt. Without a terminal (`ASK_NONINTERACTIVE=1`, or
stdin not a TTY) it never starts a sign-in; it says what to do instead.

With `--token` (a newcomer's set-up) it signs in through the browser
instead, without asking anything, and uses the hub's onboarding routes
(contract change 4). Exit 4: the hub was not reachable within 15 minutes,
or the Tailscale sign-in did not finish. Exit 5: the registration was
refused, the command expired or was already used (ask for a new one with
`/onboard`), or the hub could not identify the Tailscale login. A failed
first question or progress report does not change the exit code.

Assistant config locations, checked against each tool's docs:

| Assistant | How registered | macOS | Windows |
|---|---|---|---|
| Claude Code | `claude mcp add --transport stdio --scope user ask -- …` | `~/.claude.json` | `%USERPROFILE%\.claude.json` |
| Cursor | file edit + backup | `~/.cursor/mcp.json` | `%USERPROFILE%\.cursor\mcp.json` |
| Codex CLI | `codex mcp add ask -- …` | `$CODEX_HOME/config.toml`, default `~/.codex/config.toml` | same under `%USERPROFILE%` |
| Gemini CLI | `gemini mcp add -s user ask …` | `~/.gemini/settings.json` | `%USERPROFILE%\.gemini\settings.json` |

Windows specifics and what to watch on the first real run:
[docs/windows-first-run.md](docs/windows-first-run.md).

## Commands

```
ask "question text" [--repo org/name | --project slug] [--branch name]
                    [--context-file path | --context -]   (- reads stdin)
                    [--timeout seconds]   default 0 = wait until answered
                    [--json]
ask --resume [id]       fetch the answer to an earlier question (default: most recent pending)
ask --list              my questions still pending or answered-but-undelivered
ask mcp                 run the MCP server on stdio
ask --version | --help
ask setup | doctor | standby     see "Setup commands" below
```

- `repo` and `branch` default from the current directory's git (`origin`
  URL → `org/name`, current branch). Outside a git repo, pass `--repo` or
  `--project`.
- `--context` takes literal text, or `-` to read stdin. Max 8000
  characters; the question max 4000.
- stdout carries only the answer (or one JSON object with `--json`).
  Progress, the question id, the card link and how to resume go to stderr.

Answer on stdout:

```
ANSWER from jose (project sandbox, q_01HX…):
<answer text>
```

The answer is text a person typed in Slack. It is printed as data; `ask`
never runs or interprets it.

### Who answers: owner or mentor

The hub decides who answers when the question is created. If you have a
mentor in the hub's config, your mentor answers, from any repository
(registered as a project or not). Otherwise the project's owner answers.
The header says which:

```
ANSWER from jose (project sandbox, q_01HX…):        owner of a project
ANSWER from jose (your mentor, q_01HX…):            mentor, repo not a registered project
ANSWER from jose (your mentor, project sandbox, q_01HX…)
```

While waiting, stderr names the person ("Waiting for jose's answer…") when
the hub says who it is.

### Comments

People other than the answerer can reply in the Slack thread before the
answer. Those replies come back after the answer, labelled, on stdout and
in the MCP result:

```
COMMENTS from the thread before the answer (not the decision):
- grish, 12:03: <text>
- nora, 12:05: <text> [cut at 4000 characters]
```

The answer is the decision; comments are context only. Times are in your
local time. `--json` adds `route`, `answerer` and `comments` exactly as
the hub sent them. With an older hub that sends none of these fields, the
output is exactly as before.

### Questions started in Slack

If you forward a message to the bot or @mention it in Slack, the hub
tracks it as your question, and your AI session can pick up the answer:

- `ask --resume q_…` (or MCP `ask_resume` with that id) fetches any of
  your questions by id, even one this machine has never seen, prints it
  and sends the receipt.
- `ask --resume` with no id takes, in order: the newest question saved on
  this machine; else your oldest answered-but-undelivered question on
  the hub (from `ask` or Slack); else your oldest pending one. stderr says
  which it picked and why.
- `ask --list` adds `source` (ask/slack) and `route` (owner/mentor)
  columns when the hub provides them.

Nothing runs in the background to push answers: the session fetches them.

### Exit codes

| Code | Meaning |
|------|---------|
| 0 | answered and receipt recorded |
| 2 | configuration or usage error (no hub address, no repo, bad flags; also the hub's `invalid_request`) |
| 3 | still pending when `--timeout` ran out; stderr has `ask --resume <id>` |
| 4 | hub unreachable (after retries on the first request); also: answer printed but the receipt could not be sent |
| 5 | hub refused: `unknown_caller`, `unknown_project`, `no_owner_configured`, `chat_unavailable` (also `not_your_question`, `unknown_question` on resume) — message shown verbatim |
| 6 | question `failed` on the hub |
| 130 | interrupted with Ctrl-C (the question is kept; `ask --resume`) |

## MCP server

`ask mcp` serves two tools over stdio:

- `ask` — `{ question, repo?, project?, branch?, context?, wait_seconds? }`.
  The person answering is the user's mentor if they have one, otherwise
  the project's owner.
  Creates the question and waits up to `wait_seconds` (default 240, max
  3000). Always returns: the answer (three lines as above, plus
  `answered_by`, `via` and the card link), or `PENDING` with the question
  id and an instruction to call `ask_resume` later.
- `ask_resume` — `{ id?, wait_seconds? }`. Same wait and result for an
  earlier question, including one started in Slack; without an id, the
  same order as `ask --resume` (the result's last line says which it
  picked).

The receipt is sent after the tool result has been written to the client.
Progress notifications are sent while waiting when the client asks for
them. Repo and branch default from the server's working directory.

## Files

| | macOS (and other POSIX) | Windows |
|---|---|---|
| Config (`{"hub_url": "http://hub.invalid:8787"}`) | `$XDG_CONFIG_HOME/drunkencoders/ask.json`, default `~/.config/drunkencoders/ask.json` | `%APPDATA%\drunkencoders\ask.json` |
| Pending questions | `$XDG_STATE_HOME/drunkencoders/ask/pending.json`, default `~/.local/state/drunkencoders/ask/pending.json` | `%LOCALAPPDATA%\drunkencoders\ask\pending.json` |

`ASK_HUB_URL` overrides the config file. With neither, `ask` exits 2 and
tells you to run `ask setup`; it never guesses an address.

Every question is written to the pending file (with a fresh
`client_request_id`) before it is sent, so a crash or Ctrl-C loses nothing.
A resend reuses the same id, so the hub never creates a duplicate. The
entry is removed once the receipt succeeds; if the receipt fails it stays,
and `ask --resume` retries it.

## Development

```
npm test          # node:test against test/stub-hub.js (a contract-faithful fake hub),
                  # stub tailscale/gh/assistant CLIs, simulated Windows paths
npm run demo      # CLI end to end against the stub; stub answers after 2 s
npm run demo:mcp  # MCP handshake, tools/list, ask, against the stub
npm run demo:mentor       # mentor answers, with one comment from a third teammate
npm run demo:slack-start  # bare `ask --resume` picks up a question started in Slack
npm run rehearse:bootstrap            # bootstrap.sh for real, piped like curl|bash, stubs only
npm run rehearse:bootstrap -- all     # + installed, refused, expired, unreachable, progress-fail
```

The rehearsal runs `bootstrap.sh` in a new session without a terminal,
with a `PATH` of stubs (Homebrew installer, brew, git, node, npm, sudo, gh,
tailscale, claude, open) and a few system tools, a throwaway `HOME` and
temp dir, and the stub hub on 127.0.0.1 approving the registration after
a second. It checks the token appears nowhere afterwards and removes
everything. The real proof is a Mac with none of this:
[docs/macos-first-run.md](docs/macos-first-run.md).

PowerShell checks for `bootstrap.ps1` run in a throwaway Docker container
(PowerShell 7 on Linux, so not Windows PowerShell 5.1 or real Windows):
parser, PSScriptAnalyzer (with the 5.1 compatibility rules), the Pester
tests in `test/ps/`, and `-DryRun` with the tools mocked.

```
docker run --rm -v "$PWD:/src:ro" mcr.microsoft.com/powershell:7.4-ubuntu-22.04 pwsh -NoProfile -File /src/test/ps/run-checks.ps1
docker rmi mcr.microsoft.com/powershell:7.4-ubuntu-22.04
```

`bash bootstrap.sh --dry-run --hub http://hub.invalid:8787` and `shellcheck bootstrap.sh`
check the macOS script without changing anything.

The hub contract is "Hub HTTP API v1" in the planning folder's
`briefs/01-hub-core.md`. Tests set `ASK_HUB_URL`, `XDG_CONFIG_HOME` and
`XDG_STATE_HOME` to temp locations and never touch real config.
