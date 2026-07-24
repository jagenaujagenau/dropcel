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

- `lib/ipc.ts` becomes an `Ipc` service (`Context.Service` tag class —
  see borrowed patterns below), every `invoke` wrapped in
  `Effect.tryPromise`.
- Rust's error kinds map to `Schema.TaggedErrorClass` errors (they cross
  the IPC wire — boundary errors are schema-backed): `ValidationError`,
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

Package note: `@effect/atom-react` (not `@effect-atom/atom-react` — a
different, v3-only community package under a similarly-named scope).
Verified: `@effect/atom-react@4.0.0-beta.101` requires
`effect: ^4.0.0-beta.101` exactly, matching our pin.

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

## Patterns borrowed from t3code (production effect@4.0.0-beta.78 + atom-react)

Studied from pingdotgg/t3code (Electron desktop + web + server monorepo on
exactly our target stack). Where their v4-native practice disagrees with
v3-era advice, we follow them:

**Idioms (apply everywhere)**
- Services are `Context.Service` tag classes (interface only), with `make`
  as a separate `Effect.gen`/`Effect.fn` and `export const layer =
  Layer.effect(Tag, make)`. Not `Effect.Service`. Parameterized layers
  (`layerX(options)`) carry static config; `layerTest` naming, no
  `Live`/`Test` suffixes.
- Every wrapper-style effect fn is `Effect.fn("scope.name")(function* …)`
  — free tracing spans. Submodule imports only (`effect/Effect`,
  `effect/unstable/http`, `effect/testing/TestClock`); no barrel imports.
- Boundary errors are `Schema.TaggedErrorClass` (payload schema + message
  getter, `Schema.Defect()` for carried causes); `Data.TaggedError` only
  for purely-local errors. Our Phase 1 IPC errors are boundary errors →
  Schema-backed.
- Fully-qualified tag strings (`"dropcel/core/AccountSession"`).
- Adopt their `@effect/language-service` tsconfig ruleset wholesale
  (missingEffectServiceDependency, leakingRequirements, no-global
  Date/Timers/Fetch in Effect, importFromBarrel) — machine-checked
  v4-native style.
- Pin via pnpm catalog + `overrides` so transitive deps can't drift off
  the beta version.

**Phase 2/3 (connectivity, account session)** — their
`connection/supervisor.ts` is the template: one `run()` fiber driven by a
`Queue<Signal>` (connect/disconnect/retry/network-changed/wakeup),
desired-state in a `Ref`, public state in a `SubscriptionRef` React
subscribes to, backoff table with reset-after-stable,
`Effect.raceAllFirst` for establishment vs interrupt vs timeout,
finalizers shutting the queue. Token injection: wrap the HttpClient with
`HttpClient.mapRequestEffect` resolving the token at send time →
`HttpClientRequest.bearerToken` — this replaces our getAuthToken-then-call
pattern with a per-request interceptor.

**Phase 5 (queue)** — their `DesktopBackendManager.ts` documents migrating
*away* from a singleton service to a per-key instance factory: each
instance owns a `Ref` state machine, a `Semaphore.make(1)` serializing
start/stop, a fresh `Scope` per run (`Effect.forkIn` into the parent
scope), exponential-backoff restart with a transient/fatal distinction,
and `Effect.addFinalizer` teardown. That's our per-project deploy slot.
Their `KeyedCoalescingWorker` (TxQueue/TxRef, keeps latest value per key,
`Effect.txRetry` to await idle) is nearly a drop-in for per-project
debounce/coalescing.

**Phase 7 (render layer)** — query atoms via `Atom.family` keyed by
serialized input, piped through `Atom.swr({staleTime})` +
`Atom.setIdleTTL` + `Atom.withLabel` (devtools); live views are
`runtime.atom(stream)` with `Stream.switchMap` re-subscribing across
reconnects. Reads flatten `AsyncResult` behind one `useQuery`-shaped hook
(`{data, error, isPending, refresh}`, `Option.getOrNull` +
`Cause.squash`). Writes are **atom commands** with per-input concurrency
policies — `"singleFlight"` (dedupe concurrent identical deploys) and
`"latest"` (spammed deploy button coalesces) map 1:1 onto our queue
invariants. Optimistic updates mutate a local `SubscriptionRef` the atom
observes; the event stream reconciles. Persistence stays behind
`Context.Service` store tags implemented once over Tauri IPC (their
client-persistence split).

**Phase 5/6 testing** — `@effect/vitest` `it.effect` +
`TestClock.layer()` provided per test, `TestClock.adjust("1 second")` to
fire timers, fakes as `Layer.succeed(Tag, Tag.of({...}))` driven by
Refs/Deferreds the test controls, `awaitState` helpers observing
`SubscriptionRef.changes`. This is the harness shape for the queue
rewrite's assertion-parity translation.

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
