"use client";

/**
 * The platform owner's "Player pool" switch for one club (2026-10-27).
 * The server action authorises (superadmin) and writes through
 * `setClubPlayerPool`, which closes the club's open pool asks when it goes
 * off; this only asks, shows the answer and refreshes.
 */
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { setClubPlayerPoolAction } from "@/app/actions/pool-club-switch";

export function ClubPoolSwitch(props: { orgId: string; club: string; on: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();

  const flip = () =>
    start(async () => {
      const next = !props.on;
      if (!next && !window.confirm(`Switch the player pool off for ${props.club}? Any pool ask still open for its matches is closed now.`)) return;
      try {
        const r = await setClubPlayerPoolAction(props.orgId, next);
        if (r.ok) toast.success(r.message);
        else toast.error(r.message);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Something went wrong");
      }
    });

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        role="switch"
        aria-checked={props.on}
        aria-label={`Player pool: ${props.club}`}
        data-testid="club-pool-switch"
        disabled={pending}
        onClick={flip}
        className={`relative shrink-0 w-11 h-6 rounded-full transition-colors disabled:opacity-50 ${props.on ? "bg-green-500" : "bg-slate-300"}`}
      >
        <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${props.on ? "translate-x-5" : "translate-x-0"}`} />
      </button>
      <span className="text-sm text-slate-600">{props.on ? "On" : "Off"}</span>
    </span>
  );
}
