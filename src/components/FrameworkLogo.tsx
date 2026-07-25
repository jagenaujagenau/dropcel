import astroLogo from "../../assets/icons/astro-dark.svg";
import expressLogo from "../../assets/icons/express-dark.svg";
import honoLogo from "../../assets/icons/hono.svg";
import nextLogo from "../../assets/icons/next-dark.svg";
import nuxtLogo from "../../assets/icons/nuxt.svg";
import reactLogo from "../../assets/icons/react.svg";
import remixLogo from "../../assets/icons/remix-no-shadow.svg";
import svelteLogo from "../../assets/icons/svelte.svg";
import viteLogo from "../../assets/icons/vite.svg";
import vueLogo from "../../assets/icons/vue.svg";
import otherLogo from "../../assets/icons/other.svg";
import { FRAMEWORK_LABELS, type Framework } from "../core/types";
import { cn } from "../lib/utils";

/**
 * A framework's logo, knocked out to pure white for the card's chip.
 *
 * These are the same SVGs the macOS folder icons are generated from
 * (assets/icons), imported through Vite so the web layer can reach them —
 * they live outside `public/`, so an import is what makes them resolvable.
 *
 * `brightness(0) invert(1)` flattens each one to a white silhouette. That is
 * what makes a single treatment work across the whole set: the vendored logos
 * range from full-colour multi-path (vue, react) to solid black (next, astro,
 * express) to a dashed grey outline (other), and any background that suited
 * one would fail another. Flattened, they all sit on the brand gradient the
 * same way — which is also what the design calls for.
 */
const LOGOS: Record<Framework, string> = {
  nextjs: nextLogo,
  nuxt: nuxtLogo,
  astro: astroLogo,
  remix: remixLogo,
  svelte: svelteLogo,
  vue: vueLogo,
  vite: viteLogo,
  react: reactLogo,
  hono: honoLogo,
  express: expressLogo,
  // Plain static sites and anything undetected get the generic mark rather
  // than a monogram — there is no "static" brand to represent.
  static: otherLogo,
  unknown: otherLogo,
};

export function FrameworkLogo({
  framework,
  className,
}: {
  framework: Framework;
  className?: string;
}) {
  return (
    <img
      src={LOGOS[framework] ?? otherLogo}
      alt=""
      aria-hidden
      draggable={false}
      title={FRAMEWORK_LABELS[framework] ?? framework}
      className={cn("[filter:brightness(0)_invert(1)]", className)}
    />
  );
}
