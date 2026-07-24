import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { setProjectsLocal } from "../core/atoms";
import { getAuthToken } from "../core/auth";
import type { Project } from "../core/types";
import * as api from "../core/vercel-api";
import * as ipc from "../lib/ipc";
import { cn } from "../lib/utils";
import { Dialog } from "./ui/dialog";

/**
 * Which Vercel scope a project deploys under. Without this, `teamId` is only
 * ever inferred from the first deploy's response (see ready-effects.ts's
 * `recordVercelIds`) — a user on a team plan has no way to choose it
 * upfront, so the first deploy silently lands wherever the token's default
 * scope is. Setting it here before the first deploy makes that explicit
 * (api-deployer.ts reads `project.teamId` for every deploy call).
 */
export function TeamDialog({ project, onDone }: { project: Project; onDone: () => void }) {
  const [teams, setTeams] = useState<api.ApiTeam[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const token = await getAuthToken();
      if (!token) {
        if (!cancelled) setError("Sign in first to see your teams.");
        return;
      }
      try {
        const list = await api.run(api.listTeams({ token }));
        if (!cancelled) setTeams(list);
      } catch (e) {
        if (!cancelled) setError(String((e as { message?: string })?.message ?? e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const choose = async (teamId: string | null) => {
    setBusy(true);
    try {
      await ipc.db.setProjectTeam(project.id, teamId);
      setProjectsLocal(await ipc.db.listProjects());
      onDone();
    } finally {
      setBusy(false);
    }
  };

  const options: { id: string | null; label: string }[] = [
    { id: null, label: "Personal (your account)" },
    ...(teams ?? []).map((t) => ({ id: t.id, label: t.slug })),
  ];

  return (
    <Dialog
      open
      onClose={onDone}
      title="Deploy Under"
      description={`Which Vercel scope "${project.name}" deploys to. Takes effect on its next deploy.`}
    >
      <div className="space-y-1">
        {error && <p className="text-[11px] text-danger">{error}</p>}
        {!teams && !error && <p className="text-xs text-faint">Loading teams…</p>}
        {options.map((o) => (
          <button
            key={o.id ?? "personal"}
            disabled={busy}
            onClick={() => void choose(o.id)}
            className={cn(
              "flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-[13px] hover:bg-surface-hover disabled:opacity-50",
            )}
          >
            {o.label}
            {project.teamId === o.id && <Check className="h-3.5 w-3.5 text-success" />}
          </button>
        ))}
      </div>
    </Dialog>
  );
}
