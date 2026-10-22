"use client";

/**
 * The platform owner's override on one pairing (partner discovery, slice
 * P5, 2026-10-22; plan section 3.5, D-6): pause, resume or end it, for
 * abuse or support. The create form is gone: clubs now send each other
 * requests, and pairing two clubs on their behalf would skip their
 * consent. The server action authorises (superadmin) and the pure rules
 * decide (`planPlatformAction`): the platform resumes only its own pause,
 * and neither club can resume it. This only asks, shows the answer and
 * refreshes.
 */
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { platformPartnershipAction } from "@/app/actions/partners";
import type { PlatformAction } from "@/lib/club-partnership-rules";

const DONE: Record<PlatformAction, string> = { pause: "Paused.", resume: "Resumed.", end: "Ended." };

export function PartnerOverrideButtons(props: { id: string; status: string; pausedByPlatform: boolean; label: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();

  const act = (action: PlatformAction) =>
    start(async () => {
      if (action === "end" && !window.confirm(`End this pairing (${props.label})? The two clubs cannot ask each other for players until they are paired again.`)) return;
      try {
        const r = await platformPartnershipAction(props.id, action);
        if (r.ok) toast.success(DONE[action]);
        else toast.error("That can't be done now. Reload the page and try again.");
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Something went wrong");
      }
    });

  const button = "h-8 rounded-lg border border-slate-200 bg-white px-2 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50";
  return (
    <span className="inline-flex flex-wrap gap-1">
      {props.status === "active" && (
        <button type="button" className={button} disabled={pending} onClick={() => act("pause")} data-testid="partnership-pause">
          Pause
        </button>
      )}
      {props.status === "paused" && props.pausedByPlatform && (
        <button type="button" className={button} disabled={pending} onClick={() => act("resume")} data-testid="partnership-resume">
          Resume
        </button>
      )}
      {props.status !== "ended" && (
        <button type="button" className={button} disabled={pending} onClick={() => act("end")} data-testid="partnership-end">
          End
        </button>
      )}
    </span>
  );
}
