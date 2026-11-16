# Changelog

One entry per release, newest first. The version lives in one place, `package.json`
(the CLI and the MCP server read it at run time); a test fails when this file's
newest entry and `package.json` disagree. Semver: a patch for fixes, a minor for
anything a teammate will see, a major for something that breaks.

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
