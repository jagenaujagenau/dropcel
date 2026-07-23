# Effect-native architecture on v4 (beta)

Decision: the TypeScript layer becomes Effect-native end-to-end on
`effect@beta` (v4). We accept beta churn deliberately — v4 is the future
LTS, `@effect/platform` is already merged into it, and the deep rewrites
below (queue fibers, watcher streams, atom render layer) should be built
exactly once, on the runtime they're going to live on.

Ground rules for every phase:

- **Land green or don't land.** Each phase ends with `pnpm test` (assertion
  parity with the 128 existing tests — harnesses may change, what they
  assert may not) and `tsc --noEmit` clean.
- **Pin the beta exactly** (no `^`). Unstable namespaces
  (`effect/unstable/*`) may break in minors; upgrades are explicit commits.
- **The Rust layer does not change.** IPC command names and the
  `{ kind, message }` error shape are the frozen contract.
- Vocabulary stays per CONTEXT.md; ARCHITECTURE.md is rewritten once, at
  the end.

## Phase 0 — Foundation swap (port existing v3 code)

- `pnpm add effect@beta` (pinned), remove `@effect/platform`.
- `vercel-api.ts`: `FetchHttpClient`/`HttpClient` imports move to
  `effect/unstable/http`; the Tauri-fetch injection (CORS bypass) is
  re-wired against the v4 client. This is the phase's main risk — verify
  streaming/events polling behaves identically.
- `pipeline.ts` / `queue.ts` / `api-deployer.ts`: mechanical combinator
  renames as flagged by the compiler (Schedule composition
  `exponential ∩ recurs ∩ whileInput` must survive with identical
  semantics; we use no Schema, so the v4 Schema rewrite — the migration's
  documented "biggest hurdle" — costs us nothing).
- Deliverable: identical behavior on v4, all tests green, no new
  architecture.

## Phase 1 — Typed IPC boundary

- `lib/ipc.ts` becomes an `Ipc` service (`ServiceMap.Service`, the v4
  replacement for `Context.Tag` + `Default` layers), every `invoke`
  wrapped in `Effect.tryPromise`.
- Rust's error kinds map to tagged errors: `ValidationError`,
  `NotFoundError`, `DbError`, `IoError`, `WatchError`, `KeychainError`,
  plus `IpcDefect` for the residual `message` kind. Typed errors enter the
  system here and flow upward for free.
- Test layer: `IpcTest` scripted fake replacing today's hand-rolled ipc
  mocks module-by-module as later phases adopt it.

## Phase 2 — Effects seams as services

- `effects.ts` ports (`Notifier`, `ClipboardPort`, `TrayPort`) become
  `ServiceMap.Service` classes — the interfaces already exist; only the
  DI mechanism changes.
- Connectivity becomes a `SubscriptionRef<boolean>` fed by two sources:
  `navigator` online/offline events (instant offline signal) and the TCP
  probe on a state-dependent `Schedule` (60s online / 10s offline). Fiber
  interruption replaces the self-rescheduling `setTimeout` and its manual
  cleanup.

## Phase 3 — AccountSession, Effect-native

- Single-flight refresh: the hand-rolled inflight lock is deleted in favor
  of `Effect.cached`/semaphore — the trickiest concurrency in the app
  becomes a primitive.
- The refresh → CLI re-import → give-up chain becomes an `orElse` cascade
  with typed failures (`TokenExpired`, `TokenRevoked`, `NetworkDown`) so
  callers and, later, the UI can distinguish them.
- Identity/account-switch state: `SubscriptionRef<AccountState>`.

## Phase 4 — HeldChanges + Reconciler

- Lowest-leverage ports, done for uniformity once phases 1–3 prove the
  idioms: `HeldChanges` as `Ref<HashMap<ProjectId, HashSet<HoldReason>>>`
  with persistence as an effect; the Reconciler's decision logic stays
  pure, returning effects to run.

## Phase 5 — Queue + pipeline fiber rewrite (the big rock)

- `pipeline.ts` merges into the queue; the split existed only because
  retry logic wanted Effect and the queue didn't.
- Per-project fiber; coalescing via a sliding bounded `Queue` (capacity 1
  — which *is* "one save never produces two deployments"); cancellation
  via fiber interruption, deleting the `AbortController` adapter.
- `Effect.onInterrupt` must still fire the remote
  `PATCH /v12/deployments/{id}/cancel` — the existing abort test is the
  gate.
- Test harness moves to `@effect/vitest` + `TestClock`; every assertion in
  `queue.test.ts` (debounce, coalescing, retries, cancellation,
  per-project independence) is preserved verbatim in intent.

## Phase 6 — Watcher stream pipeline

- `fs:changed` Tauri events → `Stream.async` → `groupByKey(projectId)` →
  per-project debounced substreams feeding the queue. The TS half of the
  two-stage debounce becomes declarative stream operators; v4's stream
  rewrite (~20× faster) lands exactly here.

## Phase 7 — Render layer (@effect/atom-react) + root inversion

- The atom package ships under Effect's unified versioning — same version
  as core, no v3/v4 skew.
- The `Layer` graph lives in an `Atom.runtime`; zustand is removed; store
  projections (`projects`, `latestByProject`, `online`, `accountSwitch`)
  become derived atoms read via `useAtomValue` with atom-level
  re-render granularity.
- UI writes are atoms dispatching effects — the `runPromise` edges
  disappear. Async state reaches components as `Result`
  (waiting/success/failure), so the typed errors from phases 1 and 3
  survive to the pixel: cards can match `TokenExpired` vs `NetworkDown`
  instead of parsing strings.
- `orchestrator.ts` dissolves: construction moves into the Layer graph;
  what remains is the startup effect (`main`) forked by the runtime.

## Risk register

| Risk | Mitigation |
|---|---|
| Beta breakage in `effect/unstable/*` minors | exact version pin; upgrades are dedicated commits run against the full suite |
| v4 HttpClient behavioral drift (Tauri fetch injection, event polling) | Phase 0 is isolated + `api-deployer.test.ts` covers the protocol |
| Queue rewrite regresses "exactly one deployment per save" | assertion-parity rule; TestClock harness reviewed against fake-timers original before the rewrite starts |
| `TestClock` translation errors masking real regressions | translate harness first with the OLD implementation still in place; only then rewrite internals |
| atom-react API churn tracking core reactivity | it's Phase 7 (last); by then we're on whatever `effect/unstable/reactivity` has stabilized into |

## Sequencing

Phases 0–4 are incremental and individually small. Phase 5 is the risk
concentration and gets its own review. 6 and 7 are fast once 5 lands.
After each phase: commit on `effect-v4`; merge to `main` only when the
full ladder is green and ARCHITECTURE.md is rewritten.
