"use client";

/**
 * Share a club's poster template with other clubs, or stop (2026-10-14).
 * The server action authorises (superadmin) and checks the display name;
 * this only asks, shows the answer and refreshes.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { setTemplateSharingAction } from "@/app/actions/graphics-templates-admin";
import { DISPLAY_NAME_MAX } from "@/lib/club-graphics-choice";

export function TemplateSharingControl(props: { orgId: string; club: string; shared: boolean; displayName: string | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [name, setName] = useState(props.displayName ?? "");

  const save = (shared: boolean) =>
    start(async () => {
      try {
        const r = await setTemplateSharingAction(props.orgId, shared, name);
        if (r.ok) toast.success(r.message);
        else toast.error(r.message);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Something went wrong");
      }
    });

  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label={`Sharing for ${props.club}`}>
      <label className="text-sm text-slate-600" htmlFor={`tpl-name-${props.orgId}`}>
        Display name
      </label>
      <input
        id={`tpl-name-${props.orgId}`}
        data-testid="template-display-name"
        value={name}
        maxLength={DISPLAY_NAME_MAX}
        onChange={(e) => setName(e.target.value)}
        disabled={pending}
        placeholder="e.g. Night stadium"
        className="h-9 w-48 rounded-lg border border-slate-300 bg-white px-2 text-sm text-slate-700"
      />
      <button
        type="button"
        role="switch"
        aria-checked={props.shared}
        aria-label={`Shared with other clubs: ${props.club}`}
        data-testid="template-shared"
        disabled={pending}
        onClick={() => save(!props.shared)}
        className={`relative shrink-0 w-11 h-6 rounded-full transition-colors disabled:opacity-50 ${props.shared ? "bg-green-500" : "bg-slate-300"}`}
      >
        <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${props.shared ? "translate-x-5" : "translate-x-0"}`} />
      </button>
      <span className="text-sm text-slate-600">{props.shared ? "Shared" : "Private"}</span>
      {props.shared && name.trim() !== (props.displayName ?? "") && (
        <button
          type="button"
          data-testid="template-rename"
          disabled={pending}
          onClick={() => save(true)}
          className="h-9 rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          Save name
        </button>
      )}
    </div>
  );
}
