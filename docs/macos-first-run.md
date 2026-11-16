# macOS: the first real hands-free run

The rehearsal (`npm run rehearse:bootstrap -- all`) runs `bootstrap.sh`
with stubs only. Nothing in it touches a real Homebrew, sudo, gh,
Tailscale, browser or Slack. The first run on a Mac with none of this
installed is the real test (brief 08, phase B). This page is for whoever
watches it, next to the newcomer or on a call.

## Before the session

- The hub runs the onboarding routes (brief 08a, contract change 4). Its
  `onboarding` config has the newcomer's entry: expected GitHub login,
  mentor and mentoring channel. If she is not in the tailnet, the entry
  also has the Mac mini's share link.
- She has joined Slack and has the DM with the command. The token is valid
  for 24 hours. If it expired, Jose or the lead types `/onboard @her` for a
  fresh one.
- Jose is at hand to tap "Register" on the card.
- Her macOS account is an **administrator** (System Settings → Users &
  Groups). Without that, Homebrew cannot be installed and the script stops
  at the first step.
- She has a GitHub account and knows its password and 2FA. For Tailscale
  she needs an account, or she can create one during the sign-in.

## What she does

1. Opens Terminal, pastes the command, presses Return.
2. Types her Mac password once, when `sudo` asks ("Password:"; nothing
   shows while she types). This only happens if Homebrew is missing.
3. Waits through the installs. A missing Homebrew also installs Apple's
   Command Line Tools, which can take 5–15 minutes. macOS may ask for her
   password again for the Tailscale installer.
4. In the browser: pastes the GitHub one-time code (it is already on her
   clipboard) at github.com/login/device and approves.
5. Allows the Tailscale VPN configuration / system extension when macOS
   asks, then signs in to Tailscale in the browser.
6. If a share link was sent: accepts the share in the browser.
7. Waits for "Registered", then the standby check, `ready`, and the
   first question's answer from her mentor.

## What to watch, and the likely failure points

| Where | What can go wrong | What to check |
|---|---|---|
| `sudo -v` before Homebrew (decision 96; only when Homebrew is missing) | not an administrator (stops before sudo, one line); wrong password three times (one line) | the message; fix the account and paste again |
| Homebrew installer | Command Line Tools download slow or failing (`softwareupdate`) | the installer's own output; on failure run `xcode-select --install` by hand, then paste again |
| Homebrew's sudo | install.sh drops sudo's cached password if it was not active before it started. The script runs `sudo -v` just before, so it should be active. **Unproven** | a second password prompt, or "Insufficient permissions" |
| `brew install --cask tailscale-app` | password prompt from the pkg installer; Gatekeeper | that the app is in /Applications |
| Tailscale first start | macOS asks to allow the VPN configuration / system extension, possibly in System Settings → Privacy & Security; `tailscale status` errors until then | the "waiting for the Tailscale sign-in" line; `tailscale login` printing a URL. Whether `login` from the app's bundled CLI starts the browser flow with the GUI app is **unproven** |
| GitHub sign-in | gh run without a terminal prints the code and the URL but opens no browser; setup opens github.com/login/device itself. Clipboard copy may fail | the ">>> Your GitHub one-time code" line in Terminal |
| Share acceptance | opening the share link and signing in may not accept the share by itself; the Tailscale page may need a click. Tailscale's docs suggest the recipient may need to own/admin a tailnet. **Unproven** | "waiting for the hub … (accept the Tailscale share)" lines; give up after 15 min = exit 4 |
| `hello` | 401 (token expired/used, or bound to another login); 403 caller_unidentified (whois gave no login) | exit 5 message; `/onboard` for a new command |
| Registration card | Jose taps Refuse, or nobody taps: setup just waits while the token lives ("Waiting for <approver> to confirm in Slack…") | the card in the mentoring channel (or Jose's DM) |
| Rate limit | a 429 from the hub: setup waits for Retry-After and carries on; never a failure | "(the hub asks to slow down…)" lines |
| `claude mcp add` | Claude Code installed by this run and never started: `mcp add` is expected to work without a login. **Unproven** | "Claude Code: registered" line |
| `ready` | the hub only accepts it after a delivered standby test; setup retries 2 minutes | "is ready" line in the channel, @mention to Jose |
| First question | answered from Slack; otherwise `ask --resume` later | the card in the mentoring channel |

## Collecting diagnostics

```
ask doctor
```

One line per check (OS, Node, ask, config, Tailscale, hub health, whoami,
gh, each assistant's MCP entry). Changes nothing; it is safe to paste into
Slack. Never paste the set-up command itself anywhere but Terminal (it
contains the token).

## Repeating

The command is safe to paste again: installs are skipped and reported
`skipped`. After a completed registration, setup asks the hub `whoami`
first and, as a known teammate, skips the onboarding routes entirely. Its
progress reports still go out while the token is accepted (60 minutes
after the tap); after that they are dropped with one printed line, and
"ready" is not posted. The set-up itself still completes.
