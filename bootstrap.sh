#!/bin/bash
# drunkencoders bootstrap for macOS.
#
#   curl -fsSL <bootstrap.macos> | bash -s -- --hub <hub_url>
#
# Installs only what is missing (Homebrew after asking, Node >= 20, git, gh,
# Tailscale), installs or updates the `ask` tool, then hands over to
# `ask setup --hub <hub_url>`, which signs in, registers the MCP server and
# runs the standby check. Safe to run again. --dry-run changes nothing.
# Bash 3.2 compatible (macOS's /bin/bash). No secrets in here.

set -u

ORG="drunkencoders-hq"
ASK_SOURCE="${ASK_INSTALL_SOURCE:-git+https://github.com/${ORG}/ask.git}"
NODE_MIN_MAJOR=20
HOMEBREW_INSTALLER="https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh"

HUB=""
DRY_RUN=0

say() { printf '%s\n' "$*" >&2; }
fail() {
  # One line: what failed and what to do next.
  say "bootstrap: FAILED: $*"
  exit 1
}
plan() { say "  would run: $*"; }

usage() {
  say "usage: bash bootstrap.sh --hub <hub_url> [--dry-run]"
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --hub)
        [ $# -ge 2 ] || { usage; fail "--hub needs a value, e.g. --hub http://mini:8787"; }
        HUB="$2"
        shift 2
        ;;
      --hub=*)
        HUB="${1#--hub=}"
        shift
        ;;
      --dry-run)
        DRY_RUN=1
        shift
        ;;
      -h | --help)
        usage
        exit 0
        ;;
      *)
        usage
        fail "unknown option: $1"
        ;;
    esac
  done
  [ -n "$HUB" ] || { usage; fail "no hub address: paste the full command from your Slack DM (it ends with --hub <address>)"; }
  case "$HUB" in
    http://* | https://*) ;;
    *) fail "--hub must start with http:// or https:// (got: $HUB)" ;;
  esac
}

check_platform() {
  if [ "$(uname -s)" != "Darwin" ]; then
    fail "this script is for macOS. On Windows, paste the PowerShell command from your Slack DM instead."
  fi
  if [ "$(id -u)" -eq 0 ]; then
    fail "do not run this as root or with sudo. Paste the command again in a normal Terminal window."
  fi
}

# Ask a y/N question on the terminal (stdin is the script when piped from curl).
confirm() {
  local answer=""
  if [ ! -r /dev/tty ]; then
    return 1
  fi
  printf '%s [y/N] ' "$1" >/dev/tty
  read -r answer </dev/tty || return 1
  case "$answer" in
    y | Y | yes | YES) return 0 ;;
    *) return 1 ;;
  esac
}

# Run a command, or only print it in dry-run mode.
act() {
  if [ "$DRY_RUN" -eq 1 ]; then
    plan "$*"
    return 0
  fi
  say "  running: $*"
  "$@"
}

find_brew() {
  if command -v brew >/dev/null 2>&1; then
    command -v brew
    return 0
  fi
  local b
  for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    if [ -x "$b" ]; then
      printf '%s\n' "$b"
      return 0
    fi
  done
  return 1
}

ensure_homebrew() {
  local brew_bin
  if brew_bin="$(find_brew)"; then
    say "ok   Homebrew: $brew_bin"
    eval "$("$brew_bin" shellenv)"
    return 0
  fi
  say "--   Homebrew is not installed. It is needed to install the missing tools."
  if [ "$DRY_RUN" -eq 1 ]; then
    plan "ask: Install Homebrew with its official installer? [y/N]"
    plan "/bin/bash -c \"\$(curl -fsSL $HOMEBREW_INSTALLER)\""
    return 0
  fi
  if ! confirm "Install Homebrew now with its official installer (it will ask for your Mac password)?"; then
    fail "Homebrew is required. Install it from https://brew.sh, then paste the same command again."
  fi
  /bin/bash -c "$(curl -fsSL "$HOMEBREW_INSTALLER")" </dev/tty || fail "the Homebrew installer did not finish. Fix what it reported, then paste the same command again."
  brew_bin="$(find_brew)" || fail "Homebrew was installed but brew cannot be found. Open a new Terminal window and paste the same command again."
  eval "$("$brew_bin" shellenv)"
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
    return 0
  fi
  if [ -n "${major:-}" ]; then
    say "--   Node $(node --version) is older than $NODE_MIN_MAJOR; installing a current Node with Homebrew."
  else
    say "--   Node is not installed."
  fi
  act brew install node || fail "could not install Node with Homebrew. Run 'brew doctor', fix what it reports, then paste the same command again."
  if [ "$DRY_RUN" -eq 0 ]; then
    hash -r
    major="$(node_major)" || major=0
    [ "$major" -ge "$NODE_MIN_MAJOR" ] || fail "Node is still older than $NODE_MIN_MAJOR (another Node earlier on your PATH?). Run 'which -a node', remove the old one or put $(brew --prefix)/bin first, then paste the same command again."
  fi
}

ensure_git() {
  if git --version >/dev/null 2>&1; then
    say "ok   git $(git --version | awk '{print $3}')"
    return 0
  fi
  say "--   git is not installed."
  act brew install git || fail "could not install git with Homebrew. Run 'brew doctor', then paste the same command again."
}

ensure_gh() {
  if command -v gh >/dev/null 2>&1; then
    say "ok   GitHub CLI $(gh --version | head -n 1 | awk '{print $3}')"
    return 0
  fi
  say "--   GitHub CLI (gh) is not installed."
  act brew install gh || fail "could not install the GitHub CLI with Homebrew. Run 'brew doctor', then paste the same command again."
}

ensure_tailscale() {
  if command -v tailscale >/dev/null 2>&1 || [ -d /Applications/Tailscale.app ]; then
    say "ok   Tailscale"
    return 0
  fi
  say "--   Tailscale is not installed. Its installer may ask for your Mac password and to allow a VPN configuration."
  act brew install --cask tailscale-app || fail "could not install Tailscale. Install it from https://tailscale.com/download/mac, then paste the same command again."
  act open -a Tailscale || say "     Open Tailscale from Applications once so it can start."
}

ensure_ask() {
  local prefix
  if command -v ask >/dev/null 2>&1 && ask --version >/dev/null 2>&1; then
    say "ok   ask $(ask --version) is installed; updating it from $ASK_SOURCE"
  else
    say "--   ask is not installed."
  fi
  if [ "$DRY_RUN" -eq 0 ]; then
    prefix="$(npm prefix -g 2>/dev/null)" || fail "npm is not working. Open a new Terminal window and paste the same command again."
    if [ ! -w "$prefix/lib" ] && [ ! -w "$prefix" ]; then
      fail "npm installs global packages into $prefix, which needs admin rights. Install Node with Homebrew ('brew install node') so npm can install without sudo, then paste the same command again."
    fi
  fi
  act npm install -g "$ASK_SOURCE" || fail "could not install ask from $ASK_SOURCE. Check your internet connection, then paste the same command again."
  if [ "$DRY_RUN" -eq 0 ]; then
    hash -r
    command -v ask >/dev/null 2>&1 || fail "ask was installed but is not on your PATH ($(npm prefix -g)/bin). Open a new Terminal window and paste the same command again."
  fi
}

hand_over() {
  say ""
  say "== Handing over to: ask setup --hub $HUB"
  if [ "$DRY_RUN" -eq 1 ]; then
    plan "ask setup --hub $HUB   (with the terminal attached: signs in to Tailscale and GitHub, registers the MCP server, runs the standby check)"
    say ""
    say "DRY RUN OK: no changes made"
    exit 0
  fi
  if [ -r /dev/tty ]; then
    ask setup --hub "$HUB" </dev/tty
  else
    ask setup --hub "$HUB"
  fi
  local code=$?
  if [ "$code" -ne 0 ]; then
    say "bootstrap: FAILED: ask setup exited $code (see the message above). Fix it, then paste the same command again; it is safe to repeat."
    exit "$code"
  fi
  say "bootstrap: done. Run 'ask doctor' at any time to re-check this machine."
}

main() {
  parse_args "$@"
  check_platform
  if [ "$DRY_RUN" -eq 1 ]; then
    say "drunkencoders bootstrap (dry run: nothing will be changed)"
  else
    say "drunkencoders bootstrap"
  fi
  say "hub: $HUB"
  say "ask source: $ASK_SOURCE"
  say ""
  ensure_homebrew
  ensure_node
  ensure_git
  ensure_gh
  ensure_tailscale
  ensure_ask
  hand_over
}

main "$@"
