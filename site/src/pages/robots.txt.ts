import type { APIRoute } from "astro";

/** Generated rather than dropped in `public/`, so the sitemap line can't drift
 *  from whatever `site` is set to in astro.config.mjs. */
export const GET: APIRoute = ({ site }) =>
  new Response(
    ["User-agent: *", "Allow: /", "", `Sitemap: ${new URL("/sitemap.xml", site).href}`, ""].join(
      "\n",
    ),
    { headers: { "Content-Type": "text/plain; charset=utf-8" } },
  );
