"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2, LogOut, Power, Rocket, X } from "lucide-react";
import { toast } from "sonner";
import {
  approveClubAction,
  leaveUnsolicitedAction,
  rejectClubAction,
  suspendClubAction,
  type ClubActionResult,
} from "@/app/actions/club-decisions";
import { helloPreviewAction, ownerGoLiveNowAction } from "@/app/actions/club-setup";
import { WhatsAppMessage } from "@/components/whatsapp-message";

/**
 * The owner page's buttons. The server actions authorise for real and go
 * through `decideClub`; these only ask, show the answer and refresh.
 */
function useAction() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<ClubActionResult>, after?: () => void) =>
    start(async () => {
      try {
        const r = await fn();
        if (r.ok) toast.success(r.message);
        else toast.error(r.message);
        after?.();
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Something went wrong");
      }
    });
  return { pending, run };
}

export function DecideButtons({ orgId, club, canApprove }: { orgId: string; club: string; canApprove: boolean }) {
  const { pending, run } = useAction();
  return (
    <div className="flex flex-wrap gap-2">
      <button
        type="button"
        disabled={pending || !canApprove}
        title={canApprove ? undefined : "Self-join is switched off"}
        onClick={() => run(() => approveClubAction(orgId))}
        className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
      >
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
        Approve {club}
      </button>
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          if (window.confirm(`Reject ${club}? MatchTime leaves the group and the organiser gets one polite DM.`)) {
            run(() => rejectClubAction(orgId));
          }
        }}
        className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-white px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
      >
        <X className="h-4 w-4" />
        Reject
      </button>
    </div>
  );
}

/**
 * The off switch. Only rendered for a club approved THROUGH self-join; the
 * server refuses anything else whatever is typed. Two steps: open, then
 * type the club's name.
 */
export function TurnOffButton({ orgId, club }: { orgId: string; club: string }) {
  const { pending, run } = useAction();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const matches = typed.trim().replace(/\s+/g, " ").toLowerCase() === club.trim().replace(/\s+/g, " ").toLowerCase();

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
      >
        <Power className="h-4 w-4" />
        Turn off
      </button>
    );
  }
  return (
    <div className="w-full rounded-lg border border-red-200 bg-red-50 p-3 text-sm" role="group" aria-label={`Turn off ${club}`}>
      <p className="text-red-800">
        MatchTime leaves the group and goes silent. Nobody is messaged. Type <strong>{club}</strong> to confirm.
      </p>
      <input
        aria-label="Type the club's name to confirm"
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        className="mt-2 w-full rounded-md border border-red-300 bg-white px-2 py-1.5"
      />
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          disabled={pending || !matches}
          onClick={() =>
            run(
              () => suspendClubAction(orgId, typed),
              () => {
                setOpen(false);
                setTyped("");
              },
            )
          }
          className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 font-medium text-white hover:bg-red-700 disabled:opacity-50"
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Power className="h-4 w-4" />}
          Turn off {club}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            setOpen(false);
            setTyped("");
          }}
          className="rounded-lg px-3 py-1.5 text-slate-600 hover:bg-white"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

export function LeaveButton({ id, subject }: { id: string; subject: string }) {
  const { pending, run } = useAction();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => {
        if (window.confirm(`Leave "${subject}"? Nobody in the group is messaged.`)) {
          run(() => leaveUnsolicitedAction(id));
        }
      }}
      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
    >
      {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogOut className="h-4 w-4" />}
      Leave
    </button>
  );
}

/**
 * "Go live now" for a club that is stuck in setting up (go-live slice S5,
 * owner decision 7). Two steps, because it posts in somebody else's
 * group: open, read the exact hello that will be posted, then confirm.
 * The server action is superadmin only and is the one door that goes live
 * while the chat is still being read. A ref stops a double press sending
 * two requests.
 */
export function GoLiveNowButton({ orgId, club, disabled }: { orgId: string; club: string; disabled?: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<{ state: "loading" } | { state: "ready"; text: string } | { state: "failed" }>({
    state: "loading",
  });
  const sent = useRef(false);

  async function confirm() {
    if (sent.current) return;
    sent.current = true;
    setPending(true);
    try {
      const r = await ownerGoLiveNowAction(orgId);
      if (r.ok) toast.success(r.message);
      else toast.error(r.message);
      setOpen(false);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      sent.current = false;
      setPending(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        disabled={disabled}
        title={disabled ? "MatchTime is not in this club's group" : undefined}
        onClick={() => {
          setOpen(true);
          setPreview({ state: "loading" });
          helloPreviewAction(orgId)
            .then((text) => setPreview({ state: "ready", text }))
            .catch(() => setPreview({ state: "failed" }));
        }}
        className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
      >
        <Rocket className="h-4 w-4" />
        Go live now
      </button>
    );
  }
  return (
    <div
      className="w-full rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm"
      role="group"
      aria-label={`Take ${club} live`}
      data-testid="go-live-now-confirm"
    >
      <p className="text-emerald-950">
        MatchTime will post this in <strong>{club}</strong>&apos;s group and start working there, on the organiser&apos;s behalf. The
        chat reading stops if it has not finished.
      </p>
      <div className="mt-2">
        {preview.state === "ready" ? (
          <WhatsAppMessage text={preview.text} testId="go-live-now-preview" />
        ) : (
          <p className="text-slate-600">
            {preview.state === "loading" ? "Loading the message..." : "Couldn't load the message. It is built again when you confirm."}
          </p>
        )}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={pending || preview.state === "loading"}
          onClick={confirm}
          className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />}
          Take {club} live
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => setOpen(false)}
          className="rounded-lg px-3 py-1.5 text-slate-600 hover:bg-white"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
