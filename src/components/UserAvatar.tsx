import { useState } from "react";
import { accountStateAtom, useAtomState } from "../core/atoms";
import { cn } from "../lib/utils";

/**
 * Vercel profile picture. Fallback chain mirrors Vercel's own dashboard:
 * real photo -> generated gradient identicon (avatar.vercel.sh) -> initial.
 */
export function UserAvatar({ size = 16 }: { size?: number }) {
  return <AvatarFor {...useSignedInAccount()} size={size} />;
}

function useSignedInAccount(): { username: string | null; avatarUrl: string | null } {
  const accountState = useAtomState(accountStateAtom, {
    username: null,
    avatarUrl: null,
    pendingSwitch: null,
    lastAuthError: null,
  });
  return { username: accountState.username, avatarUrl: accountState.avatarUrl };
}

/**
 * An avatar for a *given* account, not necessarily the signed-in one.
 *
 * Project cards need this: a project can belong to an account nobody is
 * signed into right now, and its avatar has to come from the cached
 * `accounts` row rather than from live session state.
 */
export function AvatarFor({
  username,
  avatarUrl,
  size = 16,
  className,
}: {
  username: string | null;
  avatarUrl: string | null;
  size?: number;
  className?: string;
}) {
  const authedAs = username;
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
        className={cn("rounded-full border border-border object-cover", className)}
        title={authedAs ?? undefined}
      />
    );
  }
  return (
    <span
      style={style}
      title={authedAs ?? undefined}
      className={cn(
        "flex items-center justify-center rounded-full border border-border bg-surface text-[9px] uppercase text-muted",
        className,
      )}
    >
      {authedAs?.[0] ?? "?"}
    </span>
  );
}
