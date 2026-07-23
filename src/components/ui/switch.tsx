import { cn } from "../../lib/utils";

export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  "aria-label"?: string;
}

export function Switch({ checked, onCheckedChange, disabled, ...rest }: SwitchProps) {
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
      className={cn(
        "inline-flex h-[18px] w-[30px] shrink-0 items-center rounded-full p-[2px] transition-colors disabled:opacity-40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-strong",
        checked ? "bg-success" : "bg-border-strong",
      )}
      {...rest}
    >
      <span
        className={cn(
          "h-[14px] w-[14px] rounded-full bg-background shadow-sm transition-transform",
          checked ? "translate-x-[12px]" : "translate-x-0",
        )}
      />
    </button>
  );
}
