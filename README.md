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

```
npm install -g <git-url-or-path-of-this-repo>
```

`ask setup` (writes the config file, registers the MCP server with your
assistants) arrives in a later version; until then create the config file
below by hand or set `ASK_HUB_URL`.

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
ask setup | doctor | standby     reserved, not implemented yet (exit 64)
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

### Exit codes

| Code | Meaning |
|------|---------|
| 0 | answered and receipt recorded |
| 2 | configuration or usage error (no hub address, no repo, bad flags; also the hub's `invalid_request`) |
| 3 | still pending when `--timeout` ran out; stderr has `ask --resume <id>` |
| 4 | hub unreachable (after retries on the first request); also: answer printed but the receipt could not be sent |
| 5 | hub refused: `unknown_caller`, `unknown_project`, `no_owner_configured`, `chat_unavailable` (also `not_your_question`, `unknown_question` on resume) — message shown verbatim |
| 6 | question `failed` on the hub |
| 64 | subcommand not implemented yet |
| 130 | interrupted with Ctrl-C (the question is kept; `ask --resume`) |

## MCP server

`ask mcp` serves two tools over stdio:

- `ask` — `{ question, repo?, project?, branch?, context?, wait_seconds? }`.
  Creates the question and waits up to `wait_seconds` (default 240, max
  3000). Always returns: the answer (three lines as above, plus
  `answered_by`, `via` and the card link), or `PENDING` with the question
  id and an instruction to call `ask_resume` later.
- `ask_resume` — `{ id?, wait_seconds? }`. Same wait and result for an
  earlier question (default: most recent pending).

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
npm test          # node:test against test/stub-hub.js (a contract-faithful fake hub)
npm run demo      # CLI end to end against the stub; stub answers after 2 s
npm run demo:mcp  # MCP handshake, tools/list, ask, against the stub
```

The hub contract is "Hub HTTP API v1" in the planning folder's
`briefs/01-hub-core.md`. Tests set `ASK_HUB_URL`, `XDG_CONFIG_HOME` and
`XDG_STATE_HOME` to temp locations and never touch real config.
