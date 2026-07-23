import * as React from "react";
import { cn } from "../../lib/utils";

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={cn(
      "h-8 w-full rounded-md border border-border bg-surface px-2.5 text-[13px] text-foreground placeholder:text-faint focus:border-border-strong focus:outline-none select-text",
      className,
    )}
    {...props}
  />
));
Input.displayName = "Input";
