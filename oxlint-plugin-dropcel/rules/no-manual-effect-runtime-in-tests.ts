import { defineRule } from "@oxlint/plugins";
import * as Option from "effect/Option";

import { getPropertyName, isIdentifier, unwrapExpression } from "../utils.ts";

/**
 * Ported from pingdotgg/t3code's oxlint-plugin-t3code (a production
 * effect@4.0.0-beta.101 monorepo). Forces new/changed test files onto
 * @effect/vitest's `it.effect(...)` instead of hand-rolling a runtime —
 * see references/TESTING.md in the effect skill.
 *
 * The baseline below is pre-existing debt: test files written before this
 * plugin existed, on plain vitest + a manual `Effect.runPromise`/`runSync`
 * driver rather than `it.effect`. The rule permits no NET-NEW occurrences
 * in these files; every other test file must have zero. Migrating the
 * baselined files to `it.effect` is a separate, deliberate refactor, not
 * something to force through as a side effect of adding a linter.
 */
const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;
const EFFECT_RUNTIME_METHODS = new Set([
  "runCallback",
  "runCallbackWith",
  "runFork",
  "runForkWith",
  "runPromise",
  "runPromiseExit",
  "runPromiseExitWith",
  "runPromiseWith",
  "runSync",
  "runSyncExit",
  "runSyncExitWith",
  "runSyncWith",
]);

const LEGACY_BASELINE = new Map<string, number>([
  ["src/core/api-deployer.test.ts", 1],
  ["src/core/auto-deploy-gate.test.ts", 2],
  ["src/core/ipc.test.ts", 4],
  ["src/core/queue.test.ts", 2],
  ["src/core/reconciler.test.ts", 1],
  ["src/core/ready-effects.test.ts", 1],
]);

const baselineFor = (filename: string): number => {
  const normalized = filename.replaceAll("\\", "/");
  for (const [suffix, count] of LEGACY_BASELINE) {
    if (normalized.endsWith(suffix)) return count;
  }
  return 0;
};

const manualRunnerName = (callee: unknown): Option.Option<string> => {
  const expression = unwrapExpression(callee);
  if (Option.isNone(expression) || expression.value.type !== "MemberExpression") {
    return Option.none();
  }

  const object = unwrapExpression(expression.value.object);
  const property = getPropertyName(expression.value.property);
  if (Option.isNone(property)) return Option.none();

  if (isIdentifier(object, "Effect") && EFFECT_RUNTIME_METHODS.has(property.value)) {
    return Option.some(`Effect.${property.value}`);
  }

  if (isIdentifier(object, "ManagedRuntime") && property.value === "make") {
    return Option.some("ManagedRuntime.make");
  }

  return Option.none();
};

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow manually creating or running Effect runtimes in tests; use @effect/vitest.",
    },
  },
  create(context) {
    if (!TEST_FILE_PATTERN.test(context.filename)) return {};

    const allowedCount = baselineFor(context.filename);
    let occurrenceCount = 0;

    return {
      CallExpression(node) {
        const runner = manualRunnerName(node.callee);
        if (Option.isNone(runner)) return;

        occurrenceCount++;
        if (occurrenceCount <= allowedCount) return;

        context.report({
          node: node.callee,
          message: `Do not use ${runner.value} in tests. Use @effect/vitest with it.effect(...) and test layers instead.`,
        });
      },
    };
  },
});
