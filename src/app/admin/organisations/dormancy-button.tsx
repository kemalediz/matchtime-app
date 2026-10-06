"use client";

import { useState, useTransition } from "react";
import { Moon, Sun, X, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { markOrganisationDormant, reactivateOrganisation } from "@/app/actions/org";

/**
 * The one place a human declares a club gone — or brings it back.
 *
 * Marking dormant is the consequential direction (the weekly fixture
 * roll stops, silently, and nobody finds out until a kickoff that
 * doesn't happen), so it takes the same two-step as delete: modal, then
 * type the slug. Reactivating is one click, because it is the
 * reversible one.
 *
 * Only rendered for users who can perform the action — the parent page
 * decides visibility, the server action authorises for real.
 */
export function DormancyButton({
  orgId,
  orgName,
  orgSlug,
  isDormant,
}: {
  orgId: string;
  orgName: string;
  orgSlug: string;
  isDormant: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [pending, start] = useTransition();

  function close() {
    if (pending) return;
    setOpen(false);
    setTyped("");
  }

  function onWake() {
    start(async () => {
      try {
        await reactivateOrganisation(orgId);
        toast.success(`"${orgName}" is active again, fixtures resume tonight`);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Couldn't reactivate");
      }
    });
  }

  function onConfirm() {
    if (typed.trim() !== orgSlug) return;
    start(async () => {
      try {
        await markOrganisationDormant(orgId, orgSlug);
        toast.success(`"${orgName}" marked dormant, no more fixtures will be created`);
        setOpen(false);
        setTyped("");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Couldn't mark dormant");
      }
    });
  }

  if (isDormant) {
    return (
      <button
        type="button"
        onClick={onWake}
        disabled={pending}
        title="Bring this organisation back: fixtures start generating again"
        className="px-3 py-2 rounded-lg border border-emerald-200 bg-white hover:bg-emerald-50 text-emerald-700 text-sm font-medium inline-flex items-center gap-1.5 disabled:opacity-50"
      >
        {pending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sun className="w-4 h-4" />}
        Reactivate
      </button>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Mark this organisation dormant: stops fixture generation, keeps the data"
        className="px-3 py-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-600 text-sm font-medium inline-flex items-center gap-1.5"
      >
        <Moon className="w-4 h-4" />
        Mark dormant
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4"
          onClick={close}
        >
          <div
            className="bg-white rounded-2xl border border-slate-200 shadow-xl max-w-md w-full p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3 mb-4">
              <div>
                <h3 className="text-lg font-semibold text-slate-900">
                  Mark &quot;{orgName}&quot; dormant?
                </h3>
                <p className="text-sm text-slate-600 mt-1">
                  For a club that has churned or disbanded. MatchTime stops
                  creating their weekly fixtures. Nothing is deleted, and you
                  can reactivate them any time.
                </p>
              </div>
              <button
                type="button"
                onClick={close}
                className="p-1 rounded-md text-slate-400 hover:bg-slate-100"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-900 mb-4 space-y-2">
              <p>
                This is <span className="font-medium">not</span> the way to quiet
                the bot for a live club. To mute a club that is still playing,
                turn the WhatsApp bot off in settings: their fixtures keep
                being created, which is what you want.
              </p>
              <p>
                Fixtures already on the calendar are left alone. Cancel them
                separately if you want them gone.
              </p>
              <p>
                Type the org slug{" "}
                <span className="font-mono font-semibold">{orgSlug}</span> below
                to confirm.
              </p>
            </div>

            <input
              type="text"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={orgSlug}
              autoFocus
              className="w-full h-11 px-3 rounded-lg border border-slate-300 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-amber-500"
            />

            <div className="flex justify-end gap-2 mt-5">
              <button
                type="button"
                onClick={close}
                disabled={pending}
                className="px-4 py-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-sm font-medium disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={onConfirm}
                disabled={pending || typed.trim() !== orgSlug}
                className="px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-sm font-semibold disabled:opacity-50 inline-flex items-center gap-2"
              >
                {pending && <Loader2 className="w-4 h-4 animate-spin" />}
                Mark dormant
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
