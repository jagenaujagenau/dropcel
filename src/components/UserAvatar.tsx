import { useState } from "react";
import { useAppStore } from "../store/app";

/**
 * Vercel profile picture. Fallback chain mirrors Vercel's own dashboard:
 * real photo -> generated gradient identicon (avatar.vercel.sh) -> initial.
 */
export function UserAvatar({ size = 16 }: { size?: number }) {
  const authedAs = useAppStore((s) => s.authedAs);
  const avatarUrl = useAppStore((s) => s.authedAvatarUrl);
  const [failed, setFailed] = useState(0);

  const candidates = [
    ...(avatarUrl ? [avatarUrl] : []),
    ...(authedAs ? [`https://avatar.vercel.sh/${encodeURIComponent(authedAs)}?size=64`] : []),
  ];
  const src = candidates[failed];
  const style = { width: size, height: size };

  if (src) {
    return (
      <img
        key={src}
        src={src}
        alt=""
        draggable={false}
        onError={() => setFailed((n) => n + 1)}
        style={style}
        className="rounded-full border border-border"
      />
    );
  }
  return (
    <span
      style={style}
      className="flex items-center justify-center rounded-full border border-border bg-surface text-[9px] uppercase text-muted"
    >
      {authedAs?.[0] ?? "?"}
    </span>
  );
}
