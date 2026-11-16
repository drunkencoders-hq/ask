#!/bin/bash
# drunkencoders bootstrap for macOS.
#
#   curl -fsSL <bootstrap.macos> | bash -s -- --hub <hub_url> --token <set-up token> [--share <link>]
#
# Hands-free: asks no questions. Installs only what is missing, in this
# order: Homebrew, git, Node >= 20, gh, the Tailscale app, the `ask` tool, and
# Claude Code if no supported AI assistant is installed. Then hands over to
# `ask setup`, which signs in to GitHub and Tailscale in the browser, reports
# in to the hub, waits for registration, registers the MCP server, runs the
# standby check and sends a first test question. Each step is reported to the
# hub (steps done here are handed to `ask setup`, which sends them once the
# hub is reachable). You only approve macOS prompts (your Mac password) and
# the two browser sign-ins. Safe to run again. --dry-run changes nothing.
#
# Bash 3.2 compatible (macOS's /bin/bash). No secrets in here: the hub
# address and the set-up token come from your Slack message, and the token
# is never written to disk or printed.

set -u

ORG="drunkencoders-hq"
ASK_SOURCE="${ASK_INSTALL_SOURCE:-git+https://github.com/${ORG}/ask.git}"
NODE_MIN_MAJOR=20
HOMEBREW_INSTALLER="https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh"
# Where to look for things outside PATH (overridable only for the rehearsal).
BREW_PATHS="${DC_BREW_PATHS:-/opt/homebrew/bin/brew /usr/local/bin/brew}"
APPS_DIR="${DC_APPS_DIR:-/Applications}"

HUB=""
TOKEN=""
SHARE=""
DRY_RUN=0
NO_FIRST_QUESTION=0
QUEUE=""
INSTALLS=0

say() { printf '%s\n' "$*" >&2; }
fail() {
  # One line: what failed and what to do next.
  say "bootstrap: FAILED: $*"
  exit 1
}
plan() { say "  would run: $*"; }

usage() {
  say "usage: bash bootstrap.sh --hub <hub_url> [--token <set-up token>] [--share <link>] [--no-first-question] [--dry-run]"
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --hub | --token | --share)
        [ $# -ge 2 ] || { usage; fail "$1 needs a value: paste the full command from your Slack message"; }
        case "$1" in
          --hub) HUB="$2" ;;
          --token) TOKEN="$2" ;;
          --share) SHARE="$2" ;;
        esac
        shift 2
        ;;
      --hub=*) HUB="${1#--hub=}"; shift ;;
      --token=*) TOKEN="${1#--token=}"; shift ;;
      --share=*) SHARE="${1#--share=}"; shift ;;
      --no-first-question) NO_FIRST_QUESTION=1; shift ;;
      --dry-run) DRY_RUN=1; shift ;;
      -h | --help) usage; exit 0 ;;
      *) usage; fail "unknown option: $1" ;;
    esac
  done
  [ -n "$HUB" ] || { usage; fail "no hub address: paste the full command from your Slack message (it includes --hub <address>)"; }
  case "$HUB" in
    http://* | https://*) ;;
    *) fail "--hub must start with http:// or https:// (got: $HUB)" ;;
  esac
  case "$SHARE" in
    "" | https://*) ;;
    *) fail "--share must be an https:// link: paste the full command from your Slack message" ;;
  esac
}

check_platform() {
  if [ "$(uname -s)" != "Darwin" ]; then
    fail "this script is for macOS. On Windows, paste the PowerShell command from your Slack message instead."
  fi
  if [ "$(id -u)" -eq 0 ]; then
    fail "do not run this as root or with sudo. Paste the command again in a normal Terminal window."
  fi
}

# Progress for the hub: one line per report, handed to `ask setup` (which
# sends them once the hub is reachable). Never contains the token.
report() {
  local step="$1" status="$2" note="${3:-}"
  if [ "$DRY_RUN" -eq 1 ]; then
    say "  would report: $step $status${note:+ ($note)}"
    return 0
  fi
  [ -n "$QUEUE" ] && printf '%s\t%s\t%s\t%s\n' "$(date +%s)" "$step" "$status" "$note" >>"$QUEUE"
  return 0
}

# A step that was missing: run its install, or only print it in dry-run mode.
install() {
  local step="$1"
  shift
  report "$step" started
  if [ "$DRY_RUN" -eq 1 ]; then
    plan "$*"
    report "$step" "done" installed
    INSTALLS=$((INSTALLS + 1))
    return 0
  fi
  say "  running: $*"
  if "$@"; then
    report "$step" "done" installed
    INSTALLS=$((INSTALLS + 1))
    return 0
  fi
  report "$step" blocked "install failed"
  return 1
}

find_brew() {
  if command -v brew >/dev/null 2>&1; then
    command -v brew
    return 0
  fi
  local b
  for b in $BREW_PATHS; do
    if [ -x "$b" ]; then
      printf '%s\n' "$b"
      return 0
    fi
  done
  return 1
}

install_homebrew() {
  # Homebrew's installer in non-interactive mode asks nothing, but it can use
  # sudo only when sudo is already authorised: macOS asks for the password here.
  say "     macOS will ask for your Mac password (for Homebrew's installer). Type it and press Return; nothing shows while you type."
  # sudo reads the password from the terminal itself (stdin is this script).
  sudo -v || { say "     Your Mac account must be an administrator, and the password correct."; return 1; }
  NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL "$HOMEBREW_INSTALLER")" </dev/null
}

ensure_homebrew() {
  local brew_bin
  if brew_bin="$(find_brew)"; then
    say "ok   Homebrew: $brew_bin"
    report homebrew skipped "already installed"
    eval "$("$brew_bin" shellenv)"
    return 0
  fi
  say "--   Homebrew is not installed; installing it with its official installer."
  if [ "$DRY_RUN" -eq 1 ]; then
    install homebrew "sudo -v; NONINTERACTIVE=1 /bin/bash -c \"\$(curl -fsSL $HOMEBREW_INSTALLER)\""
    return 0
  fi
  install homebrew install_homebrew || fail "the Homebrew installer did not finish. Fix what it reported, then paste the same command again."
  brew_bin="$(find_brew)" || fail "Homebrew was installed but brew cannot be found. Open a new Terminal window and paste the same command again."
  eval "$("$brew_bin" shellenv)"
}

has_git() {
  local g
  g="$(command -v git)" || return 1
  # /usr/bin/git is a stub until the Command Line Tools exist; running it would
  # pop up an install dialog, so only trust it when they are installed.
  if [ "$g" = "/usr/bin/git" ]; then
    xcode-select -p >/dev/null 2>&1 || return 1
  fi
  "$g" --version >/dev/null 2>&1
}

ensure_git() {
  if has_git; then
    say "ok   git $(git --version | awk '{print $3}')"
    report git skipped "already installed"
    return 0
  fi
  say "--   git is not installed."
  install git brew install git || fail "could not install git with Homebrew. Run 'brew doctor', then paste the same command again."
}

node_major() {
  local v
  v="$(node --version 2>/dev/null)" || return 1
  v="${v#v}"
  printf '%s\n' "${v%%.*}"
}

ensure_node() {
  local major
  if major="$(node_major)" && [ "$major" -ge "$NODE_MIN_MAJOR" ]; then
    say "ok   Node $(node --version)"
    report node skipped "already installed"
    return 0
  fi
  if [ -n "${major:-}" ]; then
    say "--   Node $(node --version) is older than $NODE_MIN_MAJOR; installing a current Node with Homebrew."
  else
    say "--   Node is not installed."
  fi
  install node brew install node || fail "could not install Node with Homebrew. Run 'brew doctor', fix what it reports, then paste the same command again."
  if [ "$DRY_RUN" -eq 0 ]; then
    hash -r
    major="$(node_major)" || major=0
    [ "$major" -ge "$NODE_MIN_MAJOR" ] || fail "Node is still older than $NODE_MIN_MAJOR (another Node earlier on your PATH?). Run 'which -a node', remove the old one or put $(brew --prefix)/bin first, then paste the same command again."
  fi
}

ensure_gh() {
  if command -v gh >/dev/null 2>&1; then
    say "ok   GitHub CLI $(gh --version | head -n 1 | awk '{print $3}')"
    report gh skipped "already installed"
    return 0
  fi
  say "--   GitHub CLI (gh) is not installed."
  install gh brew install gh || fail "could not install the GitHub CLI with Homebrew. Run 'brew doctor', then paste the same command again."
}

ensure_tailscale() {
  if command -v tailscale >/dev/null 2>&1 || [ -d "$APPS_DIR/Tailscale.app" ]; then
    say "ok   Tailscale"
    report tailscale skipped "already installed"
    return 0
  fi
  say "--   Tailscale is not installed. macOS may ask for your Mac password, and later to allow a VPN configuration: allow both."
  install tailscale brew install --cask tailscale-app || fail "could not install Tailscale. Install it from https://tailscale.com/download/mac, then paste the same command again."
}

ensure_ask() {
  local prefix
  if command -v ask >/dev/null 2>&1 && ask --version >/dev/null 2>&1; then
    say "ok   ask $(ask --version) is installed; updating it from $ASK_SOURCE"
    if [ "$DRY_RUN" -eq 1 ]; then
      plan "npm install -g $ASK_SOURCE"
    else
      npm install -g "$ASK_SOURCE" || fail "could not update ask from $ASK_SOURCE. Check your internet connection, then paste the same command again."
    fi
    report ask skipped "already installed; updated"
    return 0
  fi
  say "--   ask is not installed."
  if [ "$DRY_RUN" -eq 0 ]; then
    prefix="$(npm prefix -g 2>/dev/null)" || fail "npm is not working. Open a new Terminal window and paste the same command again."
    if [ ! -w "$prefix/lib" ] && [ ! -w "$prefix" ]; then
      fail "npm installs global packages into $prefix, which needs admin rights. Install Node with Homebrew ('brew install node') so npm can install without sudo, then paste the same command again."
    fi
  fi
  install ask npm install -g "$ASK_SOURCE" || fail "could not install ask from $ASK_SOURCE. Check your internet connection, then paste the same command again."
  if [ "$DRY_RUN" -eq 0 ]; then
    hash -r
    command -v ask >/dev/null 2>&1 || fail "ask was installed but is not on your PATH ($(npm prefix -g)/bin). Open a new Terminal window and paste the same command again."
  fi
}

# Claude Code, Cursor or Codex CLI (decision 35); Claude Code if none.
ensure_assistant() {
  if command -v claude >/dev/null 2>&1 || command -v codex >/dev/null 2>&1 || command -v cursor >/dev/null 2>&1 ||
    [ -d "$APPS_DIR/Cursor.app" ] || [ -d "$HOME/Applications/Cursor.app" ] || [ -d "$HOME/.cursor" ]; then
    say "ok   an AI assistant (Claude Code, Cursor or Codex CLI)"
    report assistant skipped "already installed"
    return 0
  fi
  say "--   no supported AI assistant found; installing Claude Code."
  install assistant brew install --cask claude-code || fail "could not install Claude Code. See https://code.claude.com/docs/en/setup, then paste the same command again."
}

# A terminal to attach `ask setup` to (piped from curl, stdin is this script).
has_tty() { (exec </dev/tty) 2>/dev/null; }

hand_over() {
  local masked=""
  [ -n "$TOKEN" ] && masked=" --token ********"
  [ -n "$SHARE" ] && masked="$masked --share <link from your message>"
  [ "$NO_FIRST_QUESTION" -eq 1 ] && masked="$masked --no-first-question"
  say ""
  say "== Handing over to: ask setup --hub $HUB$masked"
  if [ "$DRY_RUN" -eq 1 ]; then
    plan "ask setup --hub $HUB$masked   (signs in to GitHub and Tailscale in the browser, reports in, waits for registration in Slack, registers the MCP server, runs the standby check, sends a first test question)"
    if [ -n "$TOKEN" ]; then
      say "  ask setup would report: github-sign-in, tailscale-sign-in, hub-reached, identity, registered, mcp, standby, ready (the steps above are sent first, once the hub is reachable)"
    fi
    say ""
    say "$INSTALLS install(s) planned."
    say "DRY RUN OK: no changes made"
    exit 0
  fi
  local args=(setup --hub "$HUB")
  [ "$NO_FIRST_QUESTION" -eq 1 ] && args+=(--no-first-question)
  local code=0
  # The token and the share link go to `ask setup` through its environment only.
  if has_tty; then
    ASK_ONBOARDING_TOKEN="$TOKEN" ASK_ONBOARDING_SHARE="$SHARE" ASK_ONBOARDING_QUEUE="$QUEUE" ask "${args[@]}" </dev/tty || code=$?
  else
    ASK_ONBOARDING_TOKEN="$TOKEN" ASK_ONBOARDING_SHARE="$SHARE" ASK_ONBOARDING_QUEUE="$QUEUE" ask "${args[@]}" </dev/null || code=$?
  fi
  if [ "$code" -ne 0 ]; then
    say "bootstrap: FAILED: ask setup exited $code (see the message above). Fix it, then paste the same command again; it is safe to repeat."
    exit "$code"
  fi
  say "bootstrap: done ($INSTALLS install(s)). Run 'ask doctor' at any time to re-check this machine."
}

main() {
  parse_args "$@"
  check_platform
  if [ "$DRY_RUN" -eq 1 ]; then
    say "drunkencoders bootstrap (dry run: nothing will be changed)"
  else
    say "drunkencoders bootstrap"
    QUEUE="$(mktemp "${TMPDIR:-/tmp}/drunkencoders-steps.XXXXXX")" || fail "could not create a temporary file. Check that your disk is not full, then paste the same command again."
    trap 'rm -f "$QUEUE"' EXIT
  fi
  say "hub: $HUB"
  say "ask source: $ASK_SOURCE"
  say ""
  ensure_homebrew
  ensure_git
  ensure_node
  ensure_gh
  ensure_tailscale
  ensure_ask
  ensure_assistant
  hand_over
}

main "$@"
