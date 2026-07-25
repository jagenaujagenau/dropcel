---
name: release
description: Cut and publish a versioned Dropcel release — preflight checks, version bump across four files, tag, and the GitHub Actions build. Use when asked to release, ship, publish, cut a version, tag a release, or bump the version of this app.
---

# Releasing Dropcel

Pushing a `v*` tag publishes a **non-draft, non-prerelease** GitHub release that
every existing install auto-updates to. Treat the tag push as irreversible and
confirm with the user before it.

## Quick start

```bash
.claude/skills/release/scripts/preflight.sh   # verification + auth + secrets gate
```

Fix anything it reports, then follow the workflow below. Never tag on a red
preflight.

## Workflow

- [ ] **Preflight passes.** The script covers a clean tree, tsc, oxlint, vitest,
      vite build, cargo test, `gh auth`, and the signing-secret gate.
- [ ] **Drive the app.** Launch it and exercise what changed. Tests and headless
      renders do not catch interaction bugs, and a release is an expensive place
      to find one. Ask the user to confirm rather than deciding this alone.
- [ ] **Agree the version with the user.** Semver over user-visible impact, not
      diff size. This is their call, not yours.
- [ ] **Bump four files, in lockstep:**
      `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, then
      `cd src-tauri && cargo check` to regenerate `Cargo.lock` (it carries the
      version too). Rewrite the single version line — do not reserialize the
      JSON, it reformats the whole file.
- [ ] **Commit** `chore: bump version to X.Y.Z` with exactly those four files.
- [ ] **Annotated tag** `git tag -a vX.Y.Z -m "..."` summarising user-visible
      changes. The message is the release's record; make it readable.
- [ ] **Confirm with the user, then push — main first, tag second:**
      ```bash
      git push origin main
      git push origin vX.Y.Z     # this is the one that publishes
      ```
- [ ] **Verify it landed** (see below) — do not trust that a push "looked fine".
- [ ] **Watch the build:** `gh run list --limit 3` then
      `gh run watch <id> --exit-status`. ~11 minutes across the
      macOS-universal / ubuntu-22.04 / windows-latest matrix.

## The signing gate

`gh secret list` must show `TAURI_SIGNING_PRIVATE_KEY` and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

Without them the release still **builds and publishes successfully** — but emits
no `.sig` files and no `latest.json`. The updater endpoint then 404s and every
existing install's auto-updater silently stops working, fixable only by another
release. This failure is invisible in a green workflow run, which is why it is a
gate and not a warning.

`APPLE_*` secrets are optional; without them macOS ships unsigned and
Gatekeeper-hostile, which is degraded but not silently broken.

## Verifying a push actually landed

A failed push exits non-zero but is easy to miss, and reads over HTTPS keep
working anonymously — so the remote stays *readable* while writes fail. Confirm
against the remote:

```bash
git ls-remote origin refs/heads/main   # must equal `git rev-parse HEAD`
git ls-remote --tags origin | grep vX.Y.Z
```

## When `gh auth` is stale

It expires silently. `gh auth login` → **HTTPS** → answer **yes** to
"Authenticate Git with your GitHub credentials". That second answer is what
repairs `git push`; authenticating only the CLI leaves pushes broken.

The user must run this themselves — it is interactive. Suggest they type
`! gh auth login`.

**Do not judge auth by `gh auth status`'s exit code.** This machine has several
accounts in `hosts.yml`, and the command returns 1 if *any* of them holds a
stale token — including ones with nothing to do with this repo. It reports
failure while the active account works perfectly. Use `gh api user` instead: it
exercises the token that will actually be used.
