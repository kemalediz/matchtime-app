"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ArrowRightLeft, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { SectionInfo } from "@/components/info/section-info";
import { useOrgLang } from "@/components/info/org-lang";
import { switchMatchFormat } from "@/app/actions/matches";

interface Sport {
  id: string;
  name: string;
  playersPerTeam: number;
}

interface Activity {
  id: string;
  name: string;
  isActive: boolean;
  sport: Sport;
}

interface MatchDetail {
  id: string;
  activityId: string;
  maxPlayers: number;
  date: string;
  activity: Activity;
  attendances: Array<{ status: string; user: { name: string | null } }>;
}

export default function SwitchFormatPage() {
  const lang = useOrgLang();
  const { matchId } = useParams<{ matchId: string }>();
  const searchParams = useSearchParams();
  const router = useRouter();
  const initialTargetId = searchParams.get("to") ?? "";

  const [match, setMatch] = useState<MatchDetail | null>(null);
  const [candidates, setCandidates] = useState<Activity[]>([]);
  const [targetId, setTargetId] = useState<string>(initialTargetId);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    (async () => {
      const [matchRes, actsRes] = await Promise.all([
        fetch(`/api/matches/${matchId}`),
        fetch(`/api/activities`),
      ]);
      if (!matchRes.ok) return;
      const m: MatchDetail = await matchRes.json();
      setMatch(m);

      const allActs: Activity[] = await actsRes.json();
      // Same sport family (first word — "Football", "Basketball", etc.) and
      // different playersPerTeam.
      const currentFamily = m.activity.sport.name.split(" ")[0];
      const currentPpt = m.activity.sport.playersPerTeam;
      const eligible = allActs.filter(
        (a) =>
          a.id !== m.activityId &&
          a.sport.name.split(" ")[0] === currentFamily &&
          a.sport.playersPerTeam !== currentPpt,
      );
      setCandidates(eligible);
      if (!initialTargetId && eligible.length === 1) setTargetId(eligible[0].id);
    })();
  }, [matchId, initialTargetId]);

  async function handleConfirm() {
    if (!targetId) return toast.error("Pick a target format");
    setSubmitting(true);
    try {
      await switchMatchFormat(matchId, targetId);
      toast.success("Match switched. Bot will announce in the group.");
      router.push(`/matches/${matchId}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to switch");
      setSubmitting(false);
    }
  }

  if (!match) {
    return <div className="p-10 text-center text-slate-400">Loading…</div>;
  }

  const confirmedCount = match.attendances.filter((a) => a.status === "CONFIRMED").length;
  const target = candidates.find((c) => c.id === targetId);
  const newMax = target ? target.sport.playersPerTeam * 2 : match.maxPlayers;
  const willBench = target ? Math.max(0, confirmedCount - newMax) : 0;

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
          <ArrowRightLeft className="w-5 h-5 text-slate-500" />
          Switch match format
          <SectionInfo k="switch" lang={lang} />
        </h2>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6 space-y-5">
        <div>
          <p className="text-sm text-slate-500">Currently</p>
          <p className="font-semibold text-slate-800">
            {match.activity.name} · {match.activity.sport.name} · {confirmedCount}/{match.maxPlayers} confirmed
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">Switch to</label>
          {candidates.length === 0 ? (
            <p className="text-sm text-slate-500">
              No compatible activity configured for this sport. Add a 5-a-side activity
              (or similar) under <Link className="text-blue-600 underline" href="/admin/activities">Activities</Link>.
            </p>
          ) : (
            <select
              value={targetId}
              onChange={(e) => setTargetId(e.target.value)}
              className="w-full h-11 px-3 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">— pick a format —</option>
              {candidates.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} · {c.sport.name} · {c.sport.playersPerTeam * 2} players
                </option>
              ))}
            </select>
          )}
        </div>

        {target && (
          <div className="p-4 rounded-lg bg-amber-50 border border-amber-200 text-sm text-amber-900">
            <p className="font-medium">What this does</p>
            <ul className="mt-2 space-y-1 text-amber-800">
              <li>• Match becomes <b>{target.sport.name}</b> ({newMax} players)</li>
              <li>
                • {Math.min(confirmedCount, newMax)} player{Math.min(confirmedCount, newMax) === 1 ? "" : "s"} stay confirmed
                {willBench > 0 && ` · ${willBench} move to bench`}
              </li>
              <li>• Bot posts the new lineup in the group</li>
              <li>• Player positions auto-transfer (same sport)</li>
            </ul>
          </div>
        )}

        <div className="flex items-center gap-3">
          <button
            onClick={handleConfirm}
            disabled={!targetId || submitting}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRightLeft className="w-4 h-4" />}
            Confirm switch
          </button>
          <Link
            href={`/admin/matches/${matchId}/teams`}
            className="px-4 py-2 rounded-lg text-slate-700 hover:bg-slate-100 font-medium"
          >
            Cancel
          </Link>
        </div>
      </div>
    </div>
  );
}
