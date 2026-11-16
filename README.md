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

Teammates get one command by Slack DM (`/onboard`):

- macOS (Terminal): `curl -fsSL <bootstrap.macos> | bash -s -- --hub <hub_url>`
- Windows (PowerShell): `& ([scriptblock]::Create((irm <bootstrap.windows>))) -Hub <hub_url>`

Add `--dry-run` / `-DryRun` to see the plan without changing anything. Both
are safe to run again. By hand: `npm install -g git+https://github.com/drunkencoders-hq/ask.git`,
then `ask setup --hub <hub_url>`.

## What the bootstrap does to your machine

### macOS (`bootstrap.sh`)

1. Refuses to run as root or on anything but macOS.
2. Homebrew: uses it if present. If it is missing, it asks y/N and only
   then runs Homebrew's official installer (which asks for your password).
3. Installs with Homebrew **only what is missing**: Node (if missing or
   older than 20), `git`, `gh` (GitHub CLI), Tailscale (`tailscale-app`
   cask, which asks to allow a VPN configuration). It opens Tailscale once.
4. Installs or updates `ask` with `npm install -g` from the public
   `drunkencoders-hq/ask` repo.
5. Runs `ask setup --hub <hub_url>`, which:
   - writes `~/.config/drunkencoders/ask.json` containing only `hub_url`;
   - signs you in to Tailscale (browser) and GitHub (`gh auth login`) if
     you are not signed in;
   - checks that the hub answers and knows who you are;
   - registers the `ask` MCP server with Claude Code, Cursor, Codex CLI and
     Gemini CLI if they are installed. It uses each tool's own
     `mcp add` command, or for Cursor it edits `~/.cursor/mcp.json` after a
     timestamped backup;
   - prints a snippet for `AGENTS.md` for other AI tools;
   - sends a standby test; "Standby verified" appears in `#runner`.

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
4. Installs or updates `ask` with `npm.cmd install -g`.
5. Runs `ask setup --hub <hub_url>` (same steps as on macOS). The config is
   `%APPDATA%\drunkencoders\ask.json`. MCP entries point at
   `node.exe …\drunkencoders-ask\src\cli.js mcp`, because some tools
   cannot start npm's `ask.cmd`.

Neither script adds a background service, scheduled task, login item,
startup entry or auto-update, and neither edits your shell profile
(package managers may add themselves to `PATH`). The only things written
are the hub address and the MCP entries. No tokens or keys are written.

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
ask setup --unregister   remove the MCP entries and the config file
ask doctor               read-only checks, one line each; non-zero if any fail
ask standby              standby test through the hub; prints "Standby verified: <you> via <hub>"
```

`ask setup` exits non-zero when any step fails: Tailscale not signed in,
the hub not answering, `gh` not signed in, the hub not knowing this
machine (`unknown_caller`, the message shows your Tailscale login to send to
Jose), an installed assistant that could not be registered, or a standby
check without a receipt. Without a terminal (`ASK_NONINTERACTIVE=1`, or
stdin not a TTY) it never starts a sign-in; it says what to do instead.

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
| Config (`{"hub_url": "http://mini:8787"}`) | `$XDG_CONFIG_HOME/drunkencoders/ask.json`, default `~/.config/drunkencoders/ask.json` | `%APPDATA%\drunkencoders\ask.json` |
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
```

PowerShell checks for `bootstrap.ps1` run in a throwaway Docker container
(PowerShell 7 on Linux, so not Windows PowerShell 5.1 or real Windows):
parser, PSScriptAnalyzer (with the 5.1 compatibility rules), the Pester
tests in `test/ps/`, and `-DryRun` with the tools mocked.

```
docker run --rm -v "$PWD:/src:ro" mcr.microsoft.com/powershell:7.4-ubuntu-22.04 pwsh -NoProfile -File /src/test/ps/run-checks.ps1
docker rmi mcr.microsoft.com/powershell:7.4-ubuntu-22.04
```

`bash bootstrap.sh --dry-run --hub http://mini:8787` and `shellcheck bootstrap.sh`
check the macOS script without changing anything.

The hub contract is "Hub HTTP API v1" in the planning folder's
`briefs/01-hub-core.md`. Tests set `ASK_HUB_URL`, `XDG_CONFIG_HOME` and
`XDG_STATE_HOME` to temp locations and never touch real config.
