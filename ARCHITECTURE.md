# Architecture

The application is split into a **native layer (Rust)** that owns everything
touching the operating system, and an **application layer (TypeScript)** that
owns all product decisions. The boundary is a small set of typed Tauri
commands and events, isolated in a single file on each side.

```
┌───────────────────────────── TypeScript ─────────────────────────────┐
│  UI (React + Tailwind + shadcn-style components)                     │
│  core/atoms.ts         the render layer: one Atom.runtime over AppLive│
│  core/composition.ts   the Layer graph (AppLive) + business logic     │
│  core/startup.ts       boot order + per-step error isolation          │
│  core/project-list.ts  what the dashboard shows, and in what order    │
│  core/project-actions.ts  what you can do to a project, and whether   │
│  core/app-state.ts     UI projection state (AppState: SubscriptionRefs)│
│  core/reconciler.ts    folder = truth: fs changes → project changes  │
│  core/watch-stream.ts  fs:changed → Stream<FsChange[]>, whole batches │
│  core/queue.ts         DeployQueue: per-project fibers, debounce,    │
│                        coalesce, retry (Schedule), cancel = interrupt│
│  core/held-changes.ts  one ledger of holds (offline/switch/git)      │
│  core/deployer.ts      Deployer interface (api-deployer implements)  │
│  core/vercel-api.ts    effect/unstable/http → Vercel REST API        │
│  core/account-session.ts token + identity lifecycle (Deferred/Sema)  │
│  core/effects.ts       services: Notifier, Clipboard, Tray, Connectivity│
│  core/ipc.ts           typed Ipc service — Rust errors → tagged errors│
│  core/state-machine.ts pure transition table                         │
│  core/detection.ts     pure framework detection                      │
│  core/errors.ts        build output → actionable explanation         │
│  lib/ipc.ts            the ONLY file that talks to Tauri (Promises)  │
├───────────────────────────────  IPC  ────────────────────────────────┤
│  startup.rs            ordered boot wiring (logger→db→watcher→icons) │
│  commands.rs           dumb, typed DB/watcher commands (macro-gen)   │
│  watcher.rs            notify + debouncer, ignore rules, dedup       │
│  files.rs              deploy manifest (SHA-1), content digests      │
│  db.rs                 SQLite (projects, deployments, logs, settings)│
│  credentials.rs        OS keychain + CLI session detection           │
│  tray.rs / tray_drop.rs  menu-bar app, status icons, drag target    │
│  projects.rs           root folder, scanning, path sandboxing        │
│  projects/naming.rs    what a dropped thing gets called              │
│  projects/import.rs    drops, adoption, the example site             │
│  git.rs                .git reading (no git binary)                  │
└────────────────────────────────  Rust  ──────────────────────────────┘
```

## Why this split

- **Rust owns side effects** (fs, processes, sqlite, keychain, tray): these
  need reliability and low memory, and Tauri gives them to us natively.
- **TypeScript owns policy** (what is a project, when to deploy, how to
  retry): this logic changes most often and benefits from fast iteration and
  cheap testing.

## Effect-native architecture (v4)

The whole TypeScript layer runs on `effect@beta` (v4) — every module above
is a `Context.Service` tag class with a `make`/`layer` pair, composed into
one `AppLive: Layer.Layer<...>` in `core/composition.ts` and driven by one
`ManagedRuntime`. There is no orchestrator class and no zustand store:

- **`lib/ipc.ts`** stays the only file that calls raw Tauri `invoke`/`listen`
  (Promise/callback surface, unchanged since before the migration).
  **`core/ipc.ts`** wraps it into the `Ipc` service — every command becomes
  `Effect.tryPromise`, and Rust's `{ kind, message }` rejections decode into
  `Schema.TaggedErrorClass` errors (`ValidationError`, `NotFoundError`,
  `DbError`, `IoError`, `WatchError`, `KeychainError`, `IpcDefect`) so
  callers can `Effect.catchTag` instead of parsing strings. Every other
  service depends on `Ipc`, never on `lib/ipc.ts` directly.
- **`core/app-state.ts`** replaces the zustand store: every UI-facing field
  (`projects`, `latestByProject`, `gitByProject`, `rootFolder`, `route`, …)
  is a `SubscriptionRef` on the `AppState` service. SQLite is still the
  source of truth; this is a live cache of it. Identity (`authedAs`,
  pending account switch) and connectivity (`online`) are **not**
  duplicated here — they read straight from `AccountSessionService.state`
  and `Connectivity.online`, the services that already own them.
- **`core/composition.ts`** is the composition root: it builds every
  service once (most have no async construction — `Ref`/`SubscriptionRef`/
  `Semaphore` state only — and are built synchronously and injected via
  `Layer.succeed`; the three services owning a long-lived fiber —
  `Connectivity`, `DeployQueue`, `WatchStream` — are real `Layer.effect`
  members so their fibers live for the app's lifetime), merges them into
  `AppLive`, and hosts the wiring between them (e.g. "the reconciler's
  `onProjectNeedsDeploy` calls the queue", "the queue's `onTransition`
  persists state and refreshes the tray") as plain functions closing over
  the built shapes. `start()` forks the startup sequence once from
  `App.tsx`'s mount effect.
- **`core/startup.ts`** owns the boot *order* and the rule that one failing
  step must not cost the watcher; `composition.ts` supplies the concrete
  effect behind each named step. The split exists because importing
  `composition.ts` builds a `ManagedRuntime`, a live Tauri-bound deployer and
  a process-wide session, so those ordering constraints could only ever be
  documented in prose. They are assertions now (`core/startup.test.ts`).
- **`core/atoms.ts`** is the render layer, built on `@effect/atom-react`
  (the package tracks `effect`'s own beta version exactly — not
  `@effect-atom/atom-react`, an unrelated v3-only community package). One
  `Atom.context({ memoMap: managedRuntime.memoMap })(AppLive)` **shares its
  memoMap with the composition root's `ManagedRuntime`** — this is load
  bearing: without it, the render layer would independently re-run every
  `Layer.effect` builder and end up with a second, divergent
  `Connectivity`/`DeployQueue`/`WatchStream`, running against different
  fibers than the ones native events actually feed. Every `SubscriptionRef`
  becomes a `runtime.subscriptionRef(...)` atom; components read them with
  `useAtomValue`/`useAtomState` (a small helper unwrapping the pre-mount
  `AsyncResult.Initial` tick). Writes are plain `runPromise`/`runFork` calls
  at the React-handler edge — no atom-command concurrency policy was
  needed, since `DeployQueue.enqueue` already coalesces concurrent calls
  per project.
- Every service is independently testable under `@effect/vitest`
  (`it.effect` + `effect/testing/TestClock` where timing matters) with no
  Tauri, no React, and no other service running — a pattern borrowed from
  `pingdotgg/t3code`'s production use of the same stack.
- Components that own real interaction logic get a `.test.tsx` under
  happy-dom, opted into per file with an `@vitest-environment happy-dom`
  docblock so the service suite keeps running on the (much faster) node
  environment. The split follows the same instinct as the services above:
  a component's *decisions* are extracted into a pure module and tested
  there (`core/commands.ts` for the ⌘K palette's catalog and ranking), and
  the DOM test covers only what can't exist without mounting — that it
  renders, that keyboard navigation moves a real selection, and that
  activating a row runs the right effect.
- Per-project reads (`latestDeploymentAtom`, `gitStatusAtom`,
  `projectSnapshotAtom`, `heldReasonsAtom`) are `Atom.family`-derived over
  synchronous `SubscriptionRef` reads, giving genuine per-project render
  isolation: a `ProjectCard` never re-renders on another project's change
  (see core/atoms.ts's block comment for how this is verified against the
  atom registry's `Object.is` short-circuit). `presentOnDiskAtom` is
  deliberately a single whole-`Set` atom — its two readers both need the
  full set regardless.

## Filesystem watching

Two debounce stages, deliberately:

1. **Rust (600 ms, notify-debouncer-full)** — collapses the raw event storm
   (editors write temp files, fire duplicate modify events) into one batch,
   then classifies each batch into per-project changes
   (`modified` / `project-added` / `project-removed`). Ignored paths are
   dropped here, before they cross IPC: VCS and dependency trees (`.git`,
   `node_modules`), framework build output (`.next`, `out`, `.nuxt`,
   `.output`, `.svelte-kit`, `.astro`, `.angular`, `.docusaurus`, `dist`,
   `build`), tooling caches (`.turbo`, `.parcel-cache`, `.cache`, `.vite`,
   `coverage`), other toolchains' output (`target`, `__pycache__`, `.venv`,
   `venv`), plus `.vercel`, `.env*` and `.DS_Store`. `files.rs` shares this
   list, so the same paths are excluded from the uploaded manifest — which is
   why the set has to stay conservative: a name that could plausibly be a
   *source* directory (`vendor`, `tmp`, `public`) is deliberately absent,
   since a false positive there silently drops files from a deploy. Missing
   entries are not merely slow: `files.rs` caps a project at 10,000 files, so
   an unignored `.svelte-kit` can fail a deploy outright.
2. **TypeScript (2 s, per project)** — a copy of a large project emits many
   batches; the queue waits for quiet before deploying. One save can never
   produce two deployments: if a change arrives while a deployment is
   running, it is coalesced into exactly one follow-up deployment.

`core/watch-stream.ts` turns Tauri's `fs:changed` event into a
`Stream<FsChange[]>` and delivers each Rust batch to the reconciler **whole
and one at a time** (`Stream.runForEach` at its default, serial,
concurrency) — never split across projects and never delivered
concurrently. This matters beyond style: a single 600ms batch can carry
structural changes for two different projects at once (the classic rename,
where one directory vanishes and another appears in the same window), and
the rename heuristic below depends on seeing both together in one
`reconcile()` call. Splitting a batch across independent per-project
deliveries would let two halves of one rename race two concurrent,
unserialized reconcile scans against the same stale snapshot.

## Never uploading credentials

Git gives every other deploy tool a staging step: a secret has to be `git add`ed
before it can be pushed, and `.gitignore` catches most of it first. This app
removes that step on purpose — whatever is in the folder goes live, and on
Vercel's Hobby tier the production URL is **public** (Deployment Protection is
a paid feature). So the deny-list in `watcher.rs` (`is_sensitive_component`)
*is* the staging step: `.env*`, `*.pem/.key/.p12/.pfx/.keystore/.jks`,
`id_rsa*` (but not `.pub`), `.npmrc`/`.netrc`/`.pgpass`/`.htpasswd`,
`credentials.json`, `service-account*`, and whole directories like `.ssh/`,
`.aws/`, `.kube/`.

The trade runs opposite to `IGNORED_DIRS`. There, a false positive silently
drops a real file from a deploy, so that list stays conservative. Here a false
*negative* publishes a private key to the open internet, so this list is
aggressive — `.key` is excluded even though Keynote also claims that extension.

Silent exclusion would be its own failure, so `files.rs`'s `walk` records every
skipped path into the manifest (`skippedSensitive`) and `api-deployer` prints
them to the build log on the stderr stream. The user is told what was withheld,
whether it was a mistake or something they expected to ship.

## Content-digest guard

Auto-deploys only run when content actually changed. Each successful deploy
records the manifest digest captured at collect time (`content_digest:<id>`
setting); right before an automatic deploy starts (post-debounce, and when
draining a coalesced mid-deploy follow-up), the queue asks `shouldSkipAuto`,
which recomputes the digest (`project_content_digest`) and skips when it
matches. This is belt-and-braces against any event source that isn't a real
content change (self-writes, metadata churn, editors touching mtimes).
Manual deploys never consult the guard, and a guard failure never blocks a
deploy.

## Rollback vs. the watch loop

Instant Rollback and a folder-watcher disagree by design. Rolling back tells
Vercel to stop auto-assigning the production domain — so every later
deployment builds and reports READY while the public URL keeps serving the
version you rolled back to. A watcher that keeps deploying into that state
produces a stream of successful-looking deploys that change nothing.

`ready-effects` detects it rather than guessing: `hasStableAddress`
(`public-url.ts`) asks whether the deployment actually received a verified
domain or a non-ephemeral alias, and `onReady` only raises the alarm when the
project **previously had** a stable URL and this deployment does not. That
second condition is what stops a first-ever deploy — which can briefly have no
alias — from being reported as a rollback. In that state the notification says
so plainly and the URL is deliberately **not** copied to the clipboard: handing
over the per-deployment host would let someone share an address that isn't
their site while their real one still serves the old version.

## Rate limits and backoff

A folder-watcher is structurally chattier than a git push, and Vercel's Hobby
limits are low (60 deployments per 5 minutes, 100/hour, 1 concurrent). Meeting
them is normal operation here, not an edge case.

`vercel-api` parses `Retry-After` off a 429 into `VercelApiError.retryAfterMs`
(seconds or HTTP-date, clamped to an hour); it flows through `DeployOutcome`
into the queue, where `Schedule.modifyDelay` uses it in place of the usual
exponential backoff. Without that the queue retried on its own 3s/6s schedule
and gave up long before the window cleared — turning a limit that resolves in
a minute into a visible deployment failure, while the retries themselves added
to the pressure.

The content-digest guard is the other half of this: the cheapest rate-limit
strategy is not deploying identical content in the first place.

## Deployment pipeline

```
detected → queued → preparing → uploading → building → ready
                        └──────────┴──────────┴──→ failed / canceled
```

- `state-machine.ts` encodes this as a transition table; `advance()` is
  monotonic so out-of-order phase reports can never move a deployment
  backwards.
- Phases come from the REST deployer (collect → upload → poll build
  state); the `Deployer` interface hides the transport entirely.
- `queue.ts`'s `DeployQueue` service runs one deployment attempt per
  project as a forked fiber, retrying with `Effect.retry({schedule:
  Schedule.exponential(baseDelayMs), times: maxRetries, while: retryable})`
  (network errors and rate limits retry; build and auth errors do not).
- Cancellation is fiber interruption: `Fiber.interrupt` reaches the
  deployer's `handle.cancel()` through `Effect.callback`'s interruption
  finalizer — the same path a remote cancel `PATCH
  /v12/deployments/{id}/cancel` needs. No `AbortController` anywhere.
- Per-project state (debounce fiber, the one active deploy, a coalesced
  pending target) lives in a `Ref<Map<projectId, Slot>>` inside the
  service; a slot is reserved *synchronously* before a deploy fiber is
  even forked, so a same-tick burst of calls for one project always
  coalesces instead of racing two real deployments.

## Offline behavior

Connectivity is monitored two ways: `navigator.onLine` events give an
instant offline signal, and a Rust-side TCP probe to `api.vercel.com:443`
is the source of truth (`onLine` reports true on internet-less LANs). The
probe re-runs every 60s online / 10s offline (the monitor policy lives
behind the Connectivity seam in `core/effects.ts` and is tested with fake
timers). While offline, changes are held instead of producing doomed API
calls. Manual deploy buttons still work offline by design — they fail fast
with the actionable network message. The top bar shows an "Offline —
changes held" pill.

**All holds share one ledger** (`core/held-changes.ts`): a project maps to
its set of hold reasons — `offline`, `account-switch`, `git-operation`.
Releasing a project's *last* reason drains it exactly once; overlapping
holds (offline during an unresolved account switch, say) can no longer
double-deploy. The offline component survives restarts: mutations persist
to the `dirty_projects` setting, and startup drains it after the first
connectivity probe — deploying each held project once, or re-holding if
still offline.

## Data

SQLite (WAL) in the platform app-data dir, owned by Rust:

- `projects` — id, name, path, framework, `vercel_project_id`, auto_deploy.
  Upserts key on `name`; renames go through `rename_project` so the row id —
  and with it the Vercel link — survives.
- `deployments` — state, target, url, error, exit_code, started/finished,
  duration (computed in SQL at terminal transitions).
- `deployment_logs` — build output lines with timestamp and stream. Written
  in batches: build output arrives in bursts (each poll returns everything
  since the last), and `composition.ts` buffers a burst into one
  `db_append_logs` insert on a microtask rather than paying an IPC round trip
  and a transaction per line while the user watches the card.
- `settings` — key/value (root folder, etc.). Tokens are **not** here; they
  live in the OS keychain.

`AppState`'s `SubscriptionRef`s are a projection of SQLite for rendering. They
are written from inside the Layer graph — `composition.ts`'s wiring functions,
plus the services that own a particular fact (`queue.ts` and `ready-effects.ts`
call `upsertDeployment`; `git.ts` is the *only* writer of `gitByProject`) — and
from `atoms.ts`'s `set*Local` writes for the four fields the UI itself owns
(`route`, `theme`, `watchPaused`, `rootFolder`). What is deliberately *not* a
writer is a React component: `projects` is refreshed only through
`composition.ts`'s `reloadProjects`, so a dialog that just wrote a project row
asks for a refresh rather than re-reading SQLite and pushing the result in.

## Drag-and-drop import

The whole app window is a drop target (`DropZone` + Tauri's drag-drop
events): dropping a folder copies it into ~/Vercel (skipping node_modules
and .git, name-deduped "blog-2" style) and the watcher deploys it like any
other arrival; dropping a single .html file wraps it in a folder as
index.html — an instant static site.

**Tray-icon drops (macOS)**: Tauri's tray API has no drop support, so
`tray_drop.rs` reaches into AppKit directly — it locates the status item's
`NSStatusBarButton` (content view of the app's `NSStatusBarWindow`),
isa-swizzles it to a subclass implementing `NSDraggingDestination` (no new
ivars, so `object_setClass` is safe and clicks stay native), registers for
file-URL drags, and forwards drops to the frontend as `tray:drop` — same
import path as window drops, with button highlight during drag-over. Every
step is best-effort: if AppKit internals change, it logs and the tray
simply stays a non-drop target. Windows/Linux tray drops remain
unsupported (no equivalent shell API).

**Dock-icon drops (macOS, bundled builds only)**: fully supported
mechanism, no swizzling — `src-tauri/Info.plist` declares Viewer-role
document types for `public.folder`/`public.item` (merged into the bundle
plist, LSHandlerRank Alternate so the app never claims default-handler
status), and `RunEvent::Opened` delivers dropped paths. Paths are stashed
natively (`PendingDrops`) because a drop can *launch* the app before the
frontend listens; the frontend drains them through the shared import flow.
Doesn't apply to `tauri dev` (no bundle → Finder won't offer the dock icon
as a target).

## Onboarding

Built around two guarantees (persisted via the `onboarded` setting):

1. **The user leaves authenticated.** Cheapest path wins: the silent CLI
   session import usually resolves auth before the first screen renders
   (Welcome then shows "Signed in ✓" and the Connect step is skipped
   entirely). Otherwise Connect offers **Sign in with Vercel** — the OAuth
   device flow (RFC 8628, same public client as `vercel login`): browser
   opens the approval page, the app shows the user code and polls the token
   endpoint, and the resulting session (access + rotating refresh token)
   feeds the normal auth machinery. Token pasting remains as the fallback.
   There is no skip: auth is the one prerequisite for the product's job,
   and with one-click sign-in there's no justification for letting a user
   walk into a guaranteed first-drop failure.
2. **The user can end with a real URL.** "Deploy an Example Site" writes a
   tiny static page into the folder (`create_example_project`), which then
   travels the entire real pipeline — detection, deploy, notification,
   URL in clipboard — while the user watches the dashboard. The aha moment
   is manufactured, not promised.

## Folder semantics

- **Drop a project in** → `project-added` → detect framework → upsert →
  deploy preview.
- **Renaming** → reconcile sees exactly one missing + one unknown directory
  and treats it as a rename, preserving the Vercel project link.
- **Deleting** → the app stops watching and cancels in-flight work; local
  history stays in SQLite and the remote Vercel project is never touched.
- **Copy in progress** → files appear before detection succeeds; every batch
  re-runs reconcile, so the project is picked up when package.json lands.

## Git-aware projects

Git state is read directly from `.git` (no git binary): branch from `HEAD`,
sha from loose refs or `packed-refs`, and in-flight operations from their
marker files (`MERGE_HEAD`, `rebase-merge/`, `rebase-apply/`,
`CHERRY_PICK_HEAD`, `BISECT_LOG`).

`.git` is only a directory in an ordinary clone. In a **linked worktree** or a
**submodule** it is a file holding `gitdir: <path>` (absolute for worktrees,
relative for submodules), so `read_git_dir` resolves that indirection before
reading anything; a worktree's refs also live in the main repository, reached
via its `commondir`. Skipping this used to report `isRepo: false` for both
cases, which silently disabled the branch lock and the mid-operation hold
exactly where they matter most — a worktree could auto-deploy mid-rebase.

Auto-deploys pass through a gate
(`shouldHoldAutoDeploy`, pure + tested):

- **Mid-operation hold** — a merge/rebase working tree is transiently broken
  (conflict markers), so auto-deploys hold and re-check every 15s until the
  operation concludes (the concluding writes live inside the ignored `.git`
  dir, hence polling rather than fs events), then deploy once.
- **Branch lock (opt-in, per project)** — a toggle in the project header
  locks auto-deploys to the branch active when enabled; switching branches
  holds silently (amber branch badge), and checking the locked branch back
  out re-triggers naturally via working-tree events.
- Otherwise every branch auto-deploys — and deploys target **production**
  (folder = truth: what's in the folder IS the live site). The opt-in
  branch lock is the tool for people who switch branches often.

Manual deploys always bypass the gate ("Deploy Preview" exists in the
context menu for a non-production check). Each deployment records branch + sha
at deploy time (shown in history and the deployment header).

**Git-connected Vercel projects step aside.** When a linked project's
`vercel project inspect` shows a connected repo, pushes already deploy it —
folder auto-deploys on top would double-deploy and ship uncommitted WIP. On
first detection the app records the repo (`remote_repo`, migration v5),
turns auto-deploy off once with an explanatory notification, and shows a
"deploys via github" badge. The user can re-enable auto-deploy deliberately;
the app never flips it again (`remote_repo` set = already handled).
Detection re-runs once per session for linked projects so integrations
added later are caught. Push-triggered deployments don't appear in the
app's history — the app only knows about deploys it ran.

## Deleting projects

Four distinct intents, one principle: *the folder is the source of truth
locally; the remote is never touched without a typed confirmation.*

1. **Folder deleted in Finder** — watching stops, in-flight deploys cancel,
   local history stays, remote untouched.
2. **Move to Trash** (project context menu) — OS trash via the `trash`
   crate (recoverable, never rm -rf), then flows through path 1.
3. **Clear history** — Settings lists removed projects ("ghosts"); clearing
   deletes the row (deployments/logs/domains cascade) plus the snapshot, in
   one command (`forget_project`) rather than two awaits from the frontend.
   Until cleared, restoring a same-named folder reattaches its history.
4. **Delete on Vercel** — the only destructive remote action: a
   type-the-project-name dialog gating `vercel project rm --yes`.

The rename heuristic (one folder vanished + one appeared) is guarded by
identity: `.vercel/project.json` travels with a renamed folder, so the
appeared folder's `projectId` must match the stored link (`isLegitRename`,
pure + tested). Without that guard, deleting `blog` and dropping in `shop`
in the same reconcile window would hand `shop` the old history and link.
The link id is captured after the first deploy and during reconcile.

## Deployment snapshots

Vercel's dashboard screenshots come from an internal service with no public
CLI/API, so the app captures its own. When a deployment reaches **ready**,
`screenshot.rs` renders the URL with a locally installed Chromium-family
browser (`--headless=new --screenshot`, 1280×800, virtual-time budget for SPA
hydration) into `app-data/snapshots/<project-id>.png`, writing via a temp
file so a failed capture never clobbers the last good image. The dashboard
shows the PNG (hydrated at startup, refreshed after every ready deployment).
Best-effort by design: no compatible browser → quiet placeholder, never an
error. Only https URLs are ever passed to the browser.

## App log

`app-data/logs/dropcel.log`: one structured line per event
(`timestamp LEVEL scope message`), written by both layers — Rust directly
(`logger::log`: watcher errors, tray-drop attach, startup banner), the
frontend via the `log_event` command (`lib/log.ts` mirrors every entry to
the devtools console). Deploy lifecycle transitions, queue holds/skips, and
uncaught errors / unhandled promise rejections all land here, so "why
didn't it deploy?" is answerable after the fact without devtools open.
Size-rotated once at 2 MB (`dropcel.log.1`). Settings → Logs reveals the
file. Logging is fire-and-forget and never affects the flow it observes.

## Design system

The UI implements Vercel's brand spec (vercel.com/design.md): the `--vbg-*`
tokens from `geist/vercel-brand.css` are vendored verbatim in `index.css`
(grayscale ramps, semantic colors, 6/8px radii) and our Tailwind semantic
names (`surface`, `border`, `muted`, `accent`…) map onto them — components
never touch `--vbg-*` directly. Tokens use `light-dark()`, so the app
follows the system color scheme with no per-component theming. Type is
Geist Sans / Geist Mono, self-hosted via Fontsource (no network fonts).

## Product scope: one screen

The app deliberately does NOT mirror Vercel's dashboard. The job is: drop a
project → it deploys → the public URL is one click/copy away. The UI is a
single dashboard (cards: snapshot, status, public URL, inline actionable
error on failure, auto-deploy toggle, right-click menu) plus Settings.
History, logs, domains, promote/rollback live in Vercel's dashboard — one
right-click ("Open in Vercel") away. Custom domains assigned there are
picked up automatically via the deployment alias list.

### The command palette (⌘K)

One screen is the right scope, but "every action lives behind a right-click"
is not — right-click is undiscoverable and unreachable from the keyboard.
`components/CommandPalette.tsx` is the keyboard route to the same actions,
plus the app-level ones (Open Folder, Settings, Rescan, and the most recent
failed build log, which otherwise takes finding the right card first).

*What* it offers is separated from *how it looks*: `core/commands.ts` is a
pure module — no React, no Tauri — that builds the catalog from the current
projects and their latest deployments, and ranks it against a query. Rules
like "no Copy URL for a project that has never deployed" live there and are
tested directly (`core/commands.test.ts`); the component supplies icons,
keyboard navigation, and the side effect per command kind.

Ranking is `lib/fuzzy.ts`, a small scoring subsequence matcher rather than a
search library: the corpus is a few dozen short labels typed against by
someone who already knows what they want, so ordering ("dp" → *D*eploy
*P*review, not the `p` inside "De**p**loy") is the entire problem. It scores
whole-query substrings, word-boundary hits and adjacent runs, and picks the
best alignment by dynamic programming — greedy left-to-right gets the
initials case wrong, which is the case that matters.

## REST API (no CLI)

The app talks to Vercel exclusively through the REST API — the Vercel CLI is
not used or required. `core/vercel-api.ts` is an Effect-based client built
on `effect/unstable/http`'s HttpClient; the fetch implementation is provided
by `tauri-plugin-http` (Rust-side HTTP), so requests bypass webview CORS.
Errors are typed (`VercelApiError` with status/code and a `retryable`
derivation feeding the queue's retry policy).

`createApiDeployer()` implements the `Deployer` interface as an Effect
pipeline:

1. **preparing** — Rust walks the project (same ignore rules as the
   watcher) and returns a SHA-1 manifest + overall content digest
   (`collect_deploy_files`).
2. **uploading** — `POST /v13/deployments` with the manifest; on
   `missing_files`, upload only the reported shas (`POST /v2/files`,
   concurrency 6) and retry. Unchanged files never re-upload.
3. **building** — poll deployment state + build events (`/v3/…/events`),
   streaming lines into SQLite and the live log view.
4. `READY`/`ERROR`/`CANCELED` map to ready/failed/canceled; failures run
   through the error explainer. Cancel = Effect interruption + `PATCH
   /v12/…/cancel`.

Auxiliary operations are all API calls too: auth (`/v2/user`), promote /
rollback / delete project, project domains (+ verification records for the
DNS instructions), git-integration detection (`project.link`), and public
URL resolution (the deployment's `alias` list). The first deploy of a
project records `vercel_project_id` + owning `team_id` (for teamId-scoped
requests) and writes `.vercel/project.json` ourselves so the rename guard's
identity marker still travels with the folder. Deployment rows store
Vercel's `dpl_…` id and `inspectorUrl` (dashboard links, promote/rollback).

Auth is a personal access token in the OS keychain. If the keychain is
empty, the app looks for a logged-in **Vercel CLI session** (its auth.json
under the per-OS config dir, plus legacy `~/.vercel` / `~/.now` locations),
validates that token against `/v2/user`, and imports it into the keychain —
zero-paste onboarding for anyone who ever ran `vercel login`. The CLI is
never executed; its file is only read.

**Imported sessions self-renew** (`core/account-session.ts`'s
`AccountSessionService` owns the whole token + identity lifecycle;
`core/auth.ts` keeps the `getAuthToken()` entry point every API caller
uses, delegating to the active session): the session's `refreshToken` is
stored as a second keychain entry and its expiry as a setting. Within 15
minutes of expiry the app runs a standard OAuth `refresh_token` grant
against the endpoint discovered from vercel.com's OpenID configuration,
using the CLI's public client id, and persists the rotated tokens.
Concurrent callers share one in-flight renewal via a `Deferred` guarded by
a `Semaphore` (rotated refresh tokens are single-use, so only the claiming
caller runs the chain; joiners await its result). The chain itself is a
typed cascade — `TokenExpired` / `TokenRevoked` / `NetworkDown` /
`NoSession` failures (`Schema.TaggedErrorClass`, boundary errors) — trying
refresh, then re-reading the CLI's `auth.json` (it may have renewed its own
session), before giving up. Manual PATs have no recorded expiry and skip
all of this. "Remove token" clears access + refresh tokens and the expiry.
Identity state (current user, pending account switch) lives in
`AccountSessionService.state`, a `SubscriptionRef<AccountState>` the render
layer reads directly.

**Account switches are detected, not guessed.** The token owner's uid is
persisted (`auth_user_id`); when `refreshAuth` sees a different uid, a
banner surfaces the choice the app cannot make itself: *Keep Links* (both
accounts on the same team — team-owned project ids remain valid) or *Start
Fresh* (clear every project's vercel id, team, git-integration state and
ownership, so next deploys create new projects under the new account; local
history and old remote projects are untouched). Start Fresh is a **single**
statement over the whole `projects` table (`start_fresh_under`), not four
writes per project plus an ownership pass — a folder half-migrated between
two accounts is worse than either end state, so it moves all at once or not
at all. The `.vercel` link files are removed separately and best-effort:
they are on disk, outside anything SQLite can make atomic, and a stale one
is re-derived on the next deploy. While the switch is unresolved, auto-deploys are held (changes accumulate
per project and deploy once after the user chooses); manual deploys remain
available as explicit intent.

## Status everywhere: tray icon and folder icons

Per-project status flows through one projection (`update_tray`), which now
drives three surfaces at once:

- **Tray icon** — rendered at runtime in pure RGBA (`tray.rs::render_icon`,
  no bundled assets): idle/all-ready is a black *template* triangle so macOS
  recolors it per menubar theme; deploying/failed switch to a theme-neutral
  gray triangle with an amber/red dot (template mode would flatten colors).
  An `#[ignore]`d test dumps the renders to PNGs for visual inspection.
- **Folder icons** (`folder_icons.rs`) — Dropbox-style: the root folder gets
  the app's triangle icon at startup, and each project folder gets a dark
  rounded tile with its **framework's logo** (Vercel's SVG icon set bundled
  from `assets/icons`, rasterized with resvg; `other.svg` for unknown/static)
  plus a green/amber/red status dot, applied via `NSWorkspace.setIcon` on
  macOS. A cache keyed on framework+status skips unchanged repaints.
  Windows (desktop.ini) and Linux (gio metadata) are planned behind the same
  platform-neutral entry points, which no-op today.
- **Tray menu** — per-project glyph rows, unchanged.

## Future native integrations

Finder *Sync-extension* badges (overlay badges on files inside projects),
Explorer overlays (Windows) and Nautilus extensions (Linux) remain out of
scope; the folder-icon module above is the first consumer of the shared
status projection they would also use.

## Testing

The rule: **the interface is the test surface.** Every TypeScript service
is a `Context.Service` with a `make`/`layer` pair and no service reaches
outside its injected deps — so each one runs under `@effect/vitest`
(`it.effect`, plus `effect/testing/TestClock` wherever timing matters:
debounce, backoff, connectivity cadence) with no Tauri, no React, and no
other service running. Side effects hide behind seams (`core/effects.ts`'s
`Notifier`/`Clipboard`/`Tray`/`Connectivity`, the `Deployer`) whose test
layers make each seam real without touching the OS.

- **Rust** (`cargo test`): SQLite migrations + CRUD, rename-preserves-link,
  ignore rules, event classification/dedup, project import/adoption cores
  (`*_in(root)` functions the commands delegate to), tray status
  aggregation + icon rendering, screenshot guards. The folder-icon asset
  generator is build-time tooling in `folder_icons/generator.rs`
  (`cargo test generate_folder_icons -- --ignored`).
- **TypeScript** (`pnpm test`): detection matrix, state-machine legality +
  monotonic advance, error explanations, the typed `Ipc` boundary (Rust
  error kinds → tagged errors), the `DeployQueue` (debounce under
  `TestClock`, coalescing, retries, cancellation reaching the deployer's
  `handle.cancel`, scope teardown leaking no fibers) against a scriptable
  mock deployer, the reconciler (rename vs delete+add, adoption,
  copy-in-progress), the watch stream (batch atomicity, serial delivery,
  scope-close unregistering the listener), account session (single-flight
  refresh via `Deferred`, CLI fallback, typed error cascade, switch
  detection/resolution), held-changes (overlapping holds, exactly-once
  drain, persistence), the REST deploy protocol (missing_files loop, abort
  → remote cancel), and connectivity policy.
