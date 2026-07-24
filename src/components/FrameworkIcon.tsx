import { Flame } from "lucide-react";
import { FRAMEWORK_LABELS, type Framework } from "../core/types";
import { cn } from "../lib/utils";

/**
 * Stand-in for a project's preview screenshot before one exists (see
 * SitePreview — screenshots only appear after the first Ready deploy).
 * A handful of frameworks get a recognizable mark; everything else falls
 * back to a monogram badge rather than guessing at an unfamiliar logo.
 */
export function FrameworkIcon({
  framework,
  className,
}: {
  framework: Framework;
  className?: string;
}) {
  switch (framework) {
    case "nextjs":
      return <NextMark className={className} />;
    case "react":
      return <ReactMark className={className} />;
    case "vite":
      return <ViteMark className={className} />;
    case "hono":
      return (
        <div className={cn("flex items-center justify-center", className)}>
          <Flame className="h-1/2 w-1/2" strokeWidth={1.5} />
        </div>
      );
    default:
      return <Monogram framework={framework} className={className} />;
  }
}

function NextMark({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center justify-center", className)}>
      <svg viewBox="0 0 24 24" className="h-1/2 w-1/2" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="11" stroke="currentColor" strokeWidth="1.4" />
        <path
          d="M8.2 8v8"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
        <path
          d="M8.2 8l7.6 8.6"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
        <path
          d="M15.8 8v6.4"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
      </svg>
    </div>
  );
}

function ReactMark({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center justify-center", className)}>
      <svg viewBox="0 0 24 24" className="h-1/2 w-1/2" fill="none" aria-hidden="true">
        <g stroke="currentColor" strokeWidth="1.1">
          <ellipse cx="12" cy="12" rx="10" ry="4" />
          <ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(60 12 12)" />
          <ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(120 12 12)" />
        </g>
        <circle cx="12" cy="12" r="1.6" fill="currentColor" />
      </svg>
    </div>
  );
}

function ViteMark({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center justify-center", className)}>
      <svg viewBox="0 0 24 24" className="h-1/2 w-1/2" fill="none" aria-hidden="true">
        <path
          d="M20.5 3.5 12.3 20.7c-.15.32-.6.32-.76 0L3.5 5.6c-.17-.37.16-.77.56-.68l7.72 1.72a.4.4 0 0 0 .17 0l7.3-1.63c.44-.1.8.34.63.7-1 2.14-2.2 4.7-2.2 4.7"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

const MONOGRAMS: Partial<Record<Framework, string>> = {
  nuxt: "Nu",
  astro: "As",
  remix: "Rx",
  svelte: "Sv",
  vue: "Vu",
  express: "Ex",
  static: "St",
};

function Monogram({ framework, className }: { framework: Framework; className?: string }) {
  const label = MONOGRAMS[framework];
  return (
    <div className={cn("flex items-center justify-center", className)}>
      <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-border text-[11px] font-medium text-faint">
        {label ?? FRAMEWORK_LABELS[framework]?.slice(0, 1)}
      </div>
    </div>
  );
}
