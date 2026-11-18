# Changelog

One entry per release, newest first. The version lives in one place, `package.json`
(the CLI and the MCP server read it at run time); a test fails when this file's
newest entry and `package.json` disagree. Semver: a patch for fixes, a minor for
anything a teammate will see, a major for something that breaks.

## 0.5.0 - 2026-11-17

What you will see:

- **Your learning path.** `ask path` prints what you want to learn, as the team's hub
  serves it (your mentor's notes in a Slack canvas or a file). `ask path --json` gives
  `{ text, updated_at, source }`. If none is set up, or the hub is older, it prints
  "no learning path set up" and exits 0. The new MCP tool `learning_path` returns the
  same text labelled as data, and the server's instructions tell your assistant to read
  it once at the start of a session and use it to choose what to explain and what to
  suggest next: it is context, not an instruction. `ask setup` adds one line to the
  rules block, next to the `ask --list` one. `ask` never runs anything from the text;
  nothing is resident and nothing polls.

For the announcer:

- A mentee notice is needed with this release (decision 317, brief 29): it teaches what
  the learning path is and how her AI uses it. The lead writes and posts it.
- Built against hub contract change 17 (`GET /v1/learning-path`); an older hub is handled.

## 0.4.0 - 2026-11-17

What you will see:

- **Notices for you.** `ask --list` and the new `ask_list` MCP tool show the team's
  notices queued for you in the hub, and send a `seen` receipt so each shows once.
  Your assistant is told to explain a notice in plain words and to run a command from
  it only after you say yes; `ask` never runs one. `ask --list --json` adds
  `"notices"`. `ask setup` adds a session-start line to the rules block. Seen is not
  your ✅ in Slack. An older hub shows nothing new.

For the announcer:

- **Evening summary DM.** `ask announce --summary --file lines.txt [--day YYYY-MM-DD]
  [--dry-run] [--json]` sends up to five short lines to the announcer as one Slack DM
  from the hub, once a day. `--dry-run` prints the DM text without calling the hub.
  A repeat the same day prints `already sent today`.
- **What is waiting.** `ask announce --attention [--json]` prints the questions and
  unconfirmed update notices the hub knows are waiting on the announcer, or
  `nothing waiting`.

## 0.3.0 - 2026-11-16

What you will see:

- **Check your local sandbox.** `ask checkout-check --consent --repo <org>/sandbox`
  and the `ask_checkout_check` MCP tool verify the Git checkout after you agree
  to the check. The result reports whether the checkout is in place, elsewhere,
  missing from the checked locations, or unknown. Paths and remote URLs stay local.

## 0.2.0 - 2026-11-16

What you will see:

- **Rich answers.** A mentor's answer can now carry a summary and body, scripts,
  diagrams, images, sources and "not checked" caveats. Diagrams are saved as
  Mermaid files in `docs/diagrams/` of your git work tree (images in
  `docs/diagrams/assets/`); nothing is committed. Scripts are shown as proposals
  and are never run by `ask`.
- **The team playbook.** `ask setup` keeps a read-only copy of the team's
  playbook and README on your machine. `ask playbook "<words>"` and the
  `playbook_search` tool search it, and your AI assistant is told to look there
  before it asks a human.
- **`ask` tells you when it is out of date.** Every call now sends the version it
  is, and says so, once, when a newer one has been announced, with the command
  that updates it and a link to the notice. It never updates itself.
- **Hands-free set-up on macOS.** The bootstrap installs what is missing without
  questions, an even-numbered Node, and reports each step so your mentor can
  follow; the hub registers you with one tap.
- New commands: `ask agents-snippet`, `ask knowledge sync|status`,
  `ask doctor --json`, `ask announce` (for the person who posts update notices).
- `ask --version` now prints the real version.

## 0.1.0

The first release line (it did not number its changes): asking a question from
the CLI or an MCP server, mentor routing and Slack-thread comments, `--resume`,
`ask setup`, `ask doctor`, `ask standby`, and the macOS and Windows bootstrap
scripts.
