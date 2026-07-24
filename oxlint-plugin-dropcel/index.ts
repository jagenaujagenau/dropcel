import { definePlugin } from "@oxlint/plugins";

import noInlineSchemaCompile from "./rules/no-inline-schema-compile.ts";
import noManualEffectRuntimeInTests from "./rules/no-manual-effect-runtime-in-tests.ts";

/**
 * Dropcel's own oxlint rules, for conventions specific to this codebase's
 * Effect v4 usage that no built-in oxlint plugin covers. Two rules ported
 * from pingdotgg/t3code's oxlint-plugin-t3code; the other two in their
 * plugin (namespace-node-imports, no-global-process-runtime) target
 * t3code-only abstractions and weren't adopted — see EFFECT-V4-PLAN.md.
 */
export default definePlugin({
  meta: {
    name: "dropcel",
  },
  rules: {
    "no-inline-schema-compile": noInlineSchemaCompile,
    "no-manual-effect-runtime-in-tests": noManualEffectRuntimeInTests,
  },
});
