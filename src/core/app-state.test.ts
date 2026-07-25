import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { make } from "./app-state";
import type { Deployment, Project } from "./types";

/**
 * These two writes are the only ones in `AppState` that encode an invariant,
 * and both invariants are about *reference identity* rather than values — the
 * render layer's per-project atoms short-circuit on `Object.is`, so preserving
 * (or correctly replacing) a reference is what decides whether the dashboard
 * re-renders. That makes them worth pinning explicitly; a change that looks
 * value-equivalent can quietly cost every card a render.
 */

const project = (name: string, over: Partial<Project> = {}): Project => ({
  id: `p-${name}`,
  name,
  path: `/Users/d/Vercel/${name}`,
  framework: "static",
  vercelProjectId: null,
  autoDeploy: true,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  lockedBranch: null,
  remoteRepo: null,
  teamId: null,
  ownerUid: null,
  ...over,
});

const deployment = (id: string, projectId: string, startedAt: string, over: Partial<Deployment> = {}): Deployment => ({
  id,
  projectId,
  state: "building",
  target: "production",
  url: null,
  error: null,
  exitCode: null,
  startedAt,
  finishedAt: null,
  durationMs: null,
  publicUrl: null,
  branch: null,
  commitSha: null,
  vercelDeploymentId: null,
  inspectorUrl: null,
  ...over,
});

describe("setProjects", () => {
  it.effect("keeps the previous array when the rows are unchanged", () =>
      Effect.gen(function* () {
        const state = yield* make;
        const first = [project("blog"), project("shop")];
        yield* state.setProjects(first);
        const stored = yield* SubscriptionRef.get(state.projects);

        // A fresh array of fresh objects — exactly what re-reading SQLite
        // produces, and what used to re-render every card in the dashboard.
        yield* state.setProjects([project("blog"), project("shop")]);
        expect(yield* SubscriptionRef.get(state.projects)).toBe(stored);
      }),
    );

  it.effect("replaces the array when any field actually changed", () =>
      Effect.gen(function* () {
        const state = yield* make;
        yield* state.setProjects([project("blog")]);
        const stored = yield* SubscriptionRef.get(state.projects);

        yield* state.setProjects([project("blog", { autoDeploy: false })]);
        const next = yield* SubscriptionRef.get(state.projects);
        expect(next).not.toBe(stored);
        expect(next[0]!.autoDeploy).toBe(false);
      }),
    );

  it.effect("replaces the array when a project is added or removed", () =>
      Effect.gen(function* () {
        const state = yield* make;
        yield* state.setProjects([project("blog")]);
        const stored = yield* SubscriptionRef.get(state.projects);
        yield* state.setProjects([project("blog"), project("shop")]);
        expect(yield* SubscriptionRef.get(state.projects)).not.toBe(stored);
      }),
    );
});

describe("upsertDeployment", () => {
  it.effect("does not let a straggling older deployment displace the newer one", () =>
      Effect.gen(function* () {
        const state = yield* make;
        const old = deployment("d-old", "p-blog", "2026-01-01T00:00:00Z");
        const current = deployment("d-new", "p-blog", "2026-01-02T00:00:00Z");

        yield* state.upsertDeployment(old);
        yield* state.upsertDeployment(current);
        // Transitions run on independent, unordered fibers: a late `canceled`
        // for the superseded run must not replace the one in flight.
        yield* state.upsertDeployment({ ...old, state: "canceled" });

        const latest = yield* SubscriptionRef.get(state.latestByProject);
        expect(latest["p-blog"]!.id).toBe("d-new");
      }),
    );

  it.effect("still applies later transitions of the deployment that is current", () =>
      Effect.gen(function* () {
        const state = yield* make;
        const d = deployment("d-1", "p-blog", "2026-01-02T00:00:00Z");
        yield* state.upsertDeployment(d);
        yield* state.upsertDeployment({ ...d, state: "ready" });

        const latest = yield* SubscriptionRef.get(state.latestByProject);
        expect(latest["p-blog"]!.state).toBe("ready");
      }),
    );

  it.effect("leaves other projects' entries reference-identical", () =>
      Effect.gen(function* () {
        const state = yield* make;
        yield* state.upsertDeployment(deployment("d-a", "p-a", "2026-01-01T00:00:00Z"));
        const untouched = (yield* SubscriptionRef.get(state.latestByProject))["p-a"];

        yield* state.upsertDeployment(deployment("d-b", "p-b", "2026-01-01T00:00:00Z"));

        // This is what `atoms.ts`'s per-project family relies on to avoid
        // re-rendering project A's card when project B deploys.
        expect((yield* SubscriptionRef.get(state.latestByProject))["p-a"]).toBe(untouched);
      }),
    );
});
