import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

/**
 * A button is a physical key: raised out of the surface, and pressed INTO it.
 *
 * The press is `translate-y-px` plus the pressed shadow, not a scale. A scale
 * shrinks the whole key toward its centre, which is what a sticker does when
 * you poke it; a key travels down along the axis the light comes from, and
 * the shadow under it collapses as it goes. Same duration, entirely different
 * object. See `--shadow-raised` in index.css for the light source all of this
 * agrees on.
 */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-[color,background-color,border-color,box-shadow,translate] duration-150 ease-out cursor-default disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-strong whitespace-nowrap active:duration-75",
  {
    variants: {
      variant: {
        // The fill gradient is white-to-black rather than a white sheen: the
        // accent inverts between themes (near-black on light, near-white on
        // dark), so a highlight-only overlay would vanish on one of them.
        // Lighter at the top and darker at the bottom shades correctly either
        // way round.
        default:
          "bg-accent text-accent-foreground shadow-raised [background-image:linear-gradient(to_bottom,oklch(1_0_0/0.16),oklch(0_0_0/0.10))] hover:bg-accent/85 active:translate-y-px active:shadow-pressed",
        secondary:
          "bg-surface border border-border text-foreground shadow-raised hover:bg-surface-hover hover:border-border-strong active:translate-y-px active:shadow-pressed",
        // Ghost stays flat on purpose. It is the one variant that is not an
        // object — it is a target on the surface, and giving it edges would
        // leave the toolbars with no quiet option left.
        ghost: "text-muted hover:text-foreground hover:bg-surface-hover active:translate-y-px",
        danger:
          "bg-transparent border border-border text-danger hover:border-danger/50 hover:bg-danger/10 active:translate-y-px",
      },
      size: {
        default: "h-8 px-3 text-[13px]",
        sm: "h-7 px-2.5 text-xs",
        icon: "h-7 w-7",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  ),
);
Button.displayName = "Button";
