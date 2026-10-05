"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, XCircle, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { SectionInfo } from "@/components/info/section-info";
import { useOrgLang } from "@/components/info/org-lang";
import { cancelMatch } from "@/app/actions/matches";
import { format } from "date-fns";

interface MatchDetail {
  id: string;
  date: string;
  maxPlayers: number;
  status: string;
  activity: { name: string };
  attendances: Array<{ status: string; user: { name: string | null } }>;
}

export default function CancelMatchPage() {
  const lang = useOrgLang();
  const { matchId } = useParams<{ matchId: string }>();
  const router = useRouter();
  const [match, setMatch] = useState<MatchDetail | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetch(`/api/matches/${matchId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then(setMatch);
  }, [matchId]);

  async function handleConfirm() {
    setSubmitting(true);
    try {
      await cancelMatch(matchId);
      toast.success("Match cancelled. Bot will announce in the group.");
      router.push(`/matches`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to cancel");
      setSubmitting(false);
    }
  }

  if (!match) return <div className="p-10 text-center text-slate-400">Loading…</div>;

  const confirmed = match.attendances.filter((a) => a.status === "CONFIRMED");

  return (
    <div className="space-y-6">
      <div>
        <Link
          href={`/admin/matches/${matchId}/teams`}
          className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 mb-2"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          Back
        </Link>
        <h2 className="text-lg font-semibold text-slate-800 flex items-center gap-2">
          <XCircle className="w-5 h-5 text-red-500" />
          Cancel match
          <SectionInfo k="cancel" lang={lang} />
        </h2>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6 space-y-5">
        <div>
          <p className="text-sm text-slate-500">Match</p>
          <p className="font-semibold text-slate-800">
            {match.activity.name} · {format(new Date(match.date), "EEE d MMM 'at' HH:mm")}
          </p>
          <p className="text-sm text-slate-500 mt-1">
            {confirmed.length}/{match.maxPlayers} confirmed
          </p>
        </div>

        <div className="p-4 rounded-lg bg-red-50 border border-red-200 text-sm text-red-900">
          <p className="font-medium">What this does</p>
          <ul className="mt-2 space-y-1 text-red-800">
            <li>• Match status → <b>CANCELLED</b></li>
            <li>• Bot stops posting reminders, polls, and DMs for this match</li>
            <li>• Bot posts a cancellation announcement in the group</li>
            <li>• No scoring, no rating, no MoM announcement for this week</li>
          </ul>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={handleConfirm}
            disabled={submitting}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-red-600 hover:bg-red-700 text-white font-medium disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <XCircle className="w-4 h-4" />}
            Cancel match
          </button>
          <Link
            href={`/admin/matches/${matchId}/teams`}
            className="px-4 py-2 rounded-lg text-slate-700 hover:bg-slate-100 font-medium"
          >
            Keep match
          </Link>
        </div>
      </div>
    </div>
  );
}
