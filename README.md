# Dropcel

**Drop a project into a folder. Seconds later, it's live.**

Dropcel is a cross-platform desktop app (Tauri 2) that does for Vercel
what Dropbox did for cloud storage. After installation a `~/Vercel` folder
appears. Every directory you put inside it is automatically detected, linked
to a Vercel project, deployed as a Preview, watched for changes and redeployed
— with a native notification when the deployment is ready.

There is no Git, no terminal, no pipeline to configure. The mental model is:

> If it's inside the Vercel folder, it's live.

## Features

- **Magic folder** — `~/Vercel` is a normal folder. Copy a project in, it
  deploys — to **production**. The folder is the live site.
- **Framework detection** — Next.js, Nuxt, Astro, Remix, Svelte, Vue, Vite,
  React, Hono, Express and static HTML, from cheap file/dependency signals.
- **Debounced auto-redeploy** — editor save storms collapse into a single
  deployment; changes during a deployment coalesce into exactly one follow-up.
- **Real state machine** — `queued → preparing → uploading → building → ready | failed | canceled`,
  with retries for transient failures (network, rate limits) and cancellation.
- **Actionable errors** — "Build failed because package.json is missing",
  never "Something went wrong".
- **One-screen UI** — the app is not a dashboard clone: status, public URL
  and actionable failure per project; everything deeper is one right-click
  away in Vercel's dashboard.
- **Native feel** — menu-bar/tray app with per-project status, notifications,
  launch-at-login, credentials in the OS keychain, SQLite persistence.
- **Folder semantics** — renaming a project keeps its Vercel link; deleting a
  folder stops watching but never touches the remote project.

## Requirements

- A Vercel personal access token (vercel.com → Account → Tokens), entered
  during onboarding or in Settings — stored in the system keychain. The app
  talks to the Vercel REST API directly; **no Vercel CLI needed**.
- Rust + Node for development builds.

## Install

```bash
brew tap jagenaujagenau/tap
brew install --cask dropcel
```

Or grab the latest release from
[GitHub Releases](https://github.com/jagenaujagenau/dropcel/releases).

## Development

```bash
pnpm install
pnpm tauri dev        # run the app
pnpm test             # TypeScript unit/integration tests (vitest)
cargo test            # Rust tests (run inside src-tauri/)
pnpm tauri build      # production bundle
```

## Documentation

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full design: layer
boundaries, the deployment pipeline, filesystem watching strategy, and the
planned migration from the Vercel CLI to the REST API.
