import { cn } from "../../lib/utils";

export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  /** Merged into the track. The off-state track is a theme token, which is
   * wrong anywhere the surface does not follow the theme — the project card's
   * footer is light in both themes, and a dark-theme `border-strong` is white
   * at 54% there, i.e. invisible. */
  className?: string;
  "aria-label"?: string;
}

export function Switch({ checked, onCheckedChange, disabled, className, ...rest }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onCheckedChange(!checked);
      }}
      // A track the knob is recessed into, and a knob raised out of it — the
      // one control in the app where the two materials are visible at once,
      // and the reason it reads as a switch at 30px rather than as two
      // rounded rectangles.
      className={cn(
        "inline-flex h-[18px] w-[30px] shrink-0 items-center rounded-full p-[2px] shadow-well transition-colors disabled:opacity-40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-strong",
        checked ? "bg-success" : "bg-border-strong",
        className,
      )}
      {...rest}
    >
      <span
        className={cn(
          // Its own top lip and contact shadow: the knob is lit by the same
          // light as every button, so it lifts out of the track instead of
          // being a paler hole in it.
          "h-[14px] w-[14px] rounded-full bg-background shadow-[inset_0_1px_0_oklch(1_0_0/0.5),0_1px_2px_oklch(0_0_0/0.45)] transition-transform",
          checked ? "translate-x-[12px]" : "translate-x-0",
        )}
      />
    </button>
  );
}
