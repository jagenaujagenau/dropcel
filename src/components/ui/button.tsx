import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-[color,background-color,border-color,transform] duration-150 ease-out cursor-default disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-strong whitespace-nowrap active:scale-[0.97] active:duration-75",
  {
    variants: {
      variant: {
        default: "bg-accent text-accent-foreground hover:bg-accent/85",
        secondary:
          "bg-surface border border-border text-foreground hover:bg-surface-hover hover:border-border-strong",
        ghost: "text-muted hover:text-foreground hover:bg-surface-hover",
        danger:
          "bg-transparent border border-border text-danger hover:border-danger/50 hover:bg-danger/10",
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
