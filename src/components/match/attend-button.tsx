"use client";

import { useState } from "react";
import { Check, X, Clock } from "lucide-react";
import { toast } from "sonner";
import { attendMatch, dropFromMatch } from "@/app/actions/attendance";

type Status = "CONFIRMED" | "BENCH" | "DROPPED" | null;

export function AttendButton({
  matchId,
  currentStatus,
  isPastDeadline,
  blockedByPriorMatch,
}: {
  matchId: string;
  currentStatus: Status;
  isPastDeadline: boolean;
  /** True when an earlier scheduled match for the same org hasn't
   *  been COMPLETED yet — registrations are paused for THIS (later)
   *  match until the cron flips the prior match. Mirrors the gate in
   *  src/lib/attendance.ts (registerAttendance) so the UI doesn't
   *  let the user click a button that would just throw server-side. */
  blockedByPriorMatch?: boolean;
}) {
  const [loading, setLoading] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const isAttending = currentStatus === "CONFIRMED" || currentStatus === "BENCH";

  async function handleAttend() {
    setLoading(true);
    try {
      await attendMatch(matchId);
      toast.success("You're in! See you at the match 🎉");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to sign up");
    } finally {
      setLoading(false);
    }
  }

  async function handleDrop() {
    setLoading(true);
    setConfirmOpen(false);
    try {
      await dropFromMatch(matchId);
      toast.success("You've dropped out. We'll miss you!");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to drop out");
    } finally {
      setLoading(false);
    }
  }

  if (isPastDeadline) {
    return (
      <button
        disabled
        className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg border border-slate-200 bg-slate-50 text-slate-400 font-medium cursor-not-allowed"
      >
        <Clock className="w-4 h-4" />
        Deadline passed
      </button>
    );
  }

  if (blockedByPriorMatch) {
    return (
      <button
        disabled
        title="Earlier match hasn't been completed yet — registrations re-open after."
        className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg border border-slate-200 bg-slate-50 text-slate-400 font-medium cursor-not-allowed"
      >
        <Clock className="w-4 h-4" />
        Wait for the previous match
      </button>
    );
  }

  if (isAttending) {
    return (
      <>
        <button
          onClick={() => setConfirmOpen(true)}
          disabled={loading}
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-red-600 hover:bg-red-700 text-white font-medium transition-colors disabled:opacity-60 active:scale-95"
        >
          <X className="w-4 h-4" />
          {loading ? "Dropping…" : "Drop out"}
        </button>

        {confirmOpen && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
            onClick={() => setConfirmOpen(false)}
          >
            <div
              className="bg-white rounded-xl shadow-xl max-w-md w-full p-6"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="text-lg font-semibold text-slate-800">Drop out of this match?</h3>
              <p className="text-sm text-slate-500 mt-2">
                You&apos;ll be removed from the player list. If you were confirmed, the first player on the bench will take your spot.
              </p>
              <div className="flex gap-3 justify-end mt-5">
                <button
                  onClick={() => setConfirmOpen(false)}
                  className="px-4 py-2 rounded-lg text-slate-700 hover:bg-slate-100 font-medium"
                >
                  Cancel
                </button>
                <button
                  onClick={handleDrop}
                  disabled={loading}
                  className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white font-medium disabled:opacity-60"
                >
                  Yes, drop out
                </button>
              </div>
            </div>
          </div>
        )}
      </>
    );
  }

  return (
    <button
      onClick={handleAttend}
      disabled={loading}
      className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium shadow-sm transition-colors disabled:opacity-60 active:scale-95"
    >
      <Check className="w-4 h-4" />
      {loading ? "Signing up…" : "I'm in!"}
    </button>
  );
}
