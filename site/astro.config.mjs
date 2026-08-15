// @ts-check
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://dropcel.app",
  // The whole page is one scroll-driven scene; there is no second document to
  // prefetch and nothing to hydrate. Keeping the default zero-JS output means
  // the only script that ships is the stage driver in index.astro.
  build: { inlineStylesheets: "auto" },
});
