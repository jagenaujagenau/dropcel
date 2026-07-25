#!/usr/bin/env bash
# Release preflight for Dropcel. Read-only: checks, never changes anything.
#
# Exits non-zero if the repo is not in a releasable state. Every check keeps
# running so one run reports every problem, rather than making the caller
# rediscover them one at a time.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." || exit 1

REPO="jagenaujagenau/dropcel"
fail=0
pass() { printf '  \033[32mok\033[0m   %s\n' "$1"; }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=1; }
warn() { printf '  \033[33mwarn\033[0m %s\n' "$1"; }
section() { printf '\n\033[1m%s\033[0m\n' "$1"; }

section "Working tree"
if [ -z "$(git status --porcelain)" ]; then
  pass "clean"
else
  bad "uncommitted changes — commit or stash before releasing"
  git status --short | sed 's/^/       /' | head -10
fi

section "Verification"
run() { # run <label> <cmd...>
  local label=$1; shift
  if out=$("$@" 2>&1); then pass "$label"; else
    bad "$label"; echo "$out" | tail -15 | sed 's/^/       /'
  fi
}
run "tsc"        npx tsc --noEmit
run "oxlint"     npx oxlint
run "vitest"     npx vitest run
run "vite build" npx vite build
run "cargo test" bash -c 'cd src-tauri && cargo test'

section "Versions in lockstep"
pkg=$(node -p "require('./package.json').version" 2>/dev/null)
conf=$(node -p "require('./src-tauri/tauri.conf.json').version" 2>/dev/null)
cargo_v=$(grep -m1 '^version' src-tauri/Cargo.toml | sed 's/.*"\(.*\)".*/\1/')
lock_v=$(awk '/^name = "dropcel"$/{getline; print}' src-tauri/Cargo.lock | sed 's/.*"\(.*\)".*/\1/')
echo "       package.json=$pkg  tauri.conf.json=$conf  Cargo.toml=$cargo_v  Cargo.lock=$lock_v"
if [ "$pkg" = "$conf" ] && [ "$pkg" = "$cargo_v" ] && [ "$pkg" = "$lock_v" ]; then
  pass "all four agree ($pkg)"
else
  bad "version mismatch — bump all four (cargo check regenerates Cargo.lock)"
fi

if git rev-parse "v$pkg" >/dev/null 2>&1; then
  warn "tag v$pkg already exists locally — bump before tagging again"
fi

section "GitHub auth"
# `gh auth status` exit code is NOT usable here: it returns 1 when ANY account
# in hosts.yml has a stale token, including accounts unrelated to this repo, so
# it fails even when the active account is perfectly fine. Ask the API who we
# are instead — that exercises the token that will actually be used.
#
# Reads over HTTPS also work anonymously, so the remote staying readable proves
# nothing about whether a push will succeed.
if who=$(gh api user -q .login 2>/dev/null) && [ -n "$who" ]; then
  pass "gh authenticated as $who"
else
  bad "gh token invalid — user must run: gh auth login (HTTPS, and say yes to
       'Authenticate Git with your GitHub credentials')"
fi

section "Release signing secrets"
secrets=$(gh secret list --repo "$REPO" 2>/dev/null | awk '{print $1}')
if [ -z "$secrets" ]; then
  bad "could not read secrets (auth?) — cannot verify the updater will be signed"
else
  for s in TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD; do
    if grep -qx "$s" <<<"$secrets"; then pass "$s"; else
      bad "$s missing — the release would publish with no latest.json and
       silently break every existing install's auto-updater"
    fi
  done
  for s in APPLE_CERTIFICATE APPLE_SIGNING_IDENTITY APPLE_ID APPLE_TEAM_ID; do
    grep -qx "$s" <<<"$secrets" || warn "$s missing — macOS ships unsigned"
  done
fi

section "Unpushed work"
ahead=$(git rev-list --count origin/main..HEAD 2>/dev/null || echo "?")
echo "       $ahead commit(s) ahead of origin/main"

if [ "$fail" -eq 0 ]; then
  printf '\n\033[32mPreflight passed.\033[0m Drive the app, agree a version, then tag.\n'
else
  printf '\n\033[31mPreflight failed.\033[0m Do not tag.\n'
fi
exit "$fail"
