"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Link2, Check } from "lucide-react";
import { toast } from "sonner";
import {
  listUnresolved,
  assignUnresolvedToPlayer,
  type UnresolvedGroup,
} from "@/app/actions/unresolved";

interface Player {
  id: string;
  name: string | null;
  email: string;
}

const INTENT_LABEL: Record<string, string> = {
  in: "wants to join",
  out: "dropping out",
  replacement_request: "dropping out (asked for cover)",
};

export default function UnresolvedPage() {
  const [orgId, setOrgId] = useState<string | null>(null);
  const [groups, setGroups] = useState<UnresolvedGroup[]>([]);
  const [players, setPlayers] = useState<Player[]>([]);
  const [loading, setLoading] = useState(true);
  const [pick, setPick] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/org/settings")
      .then((r) => r.json())
      .then((d) => setOrgId(d.id));
    fetch("/api/players")
      .then((r) => r.json())
      .then((d) => setPlayers((Array.isArray(d) ? d : d.players ?? []) as Player[]));
  }, []);

  useEffect(() => {
    if (!orgId) return;
    listUnresolved(orgId)
      .then(setGroups)
      .catch((e) => toast.error(e instanceof Error ? e.message : "Failed to load"))
      .finally(() => setLoading(false));
  }, [orgId]);

  async function handleAssign(g: UnresolvedGroup, applyLatestIntent: boolean) {
    if (!orgId) return;
    const userId = pick[g.key];
    if (!userId) {
      toast.error("Pick a player first");
      return;
    }
    setBusy(g.key);
    try {
      const res = await assignUnresolvedToPlayer({
        orgId,
        pushname: g.pushname,
        userId,
        applyLatestIntent,
      });
      const who = players.find((p) => p.id === userId)?.name ?? "player";
      toast.success(
        `Linked "${g.pushname}" → ${who}` +
          (res.applied ? ` · applied ${res.applied}` : "") +
          (res.aliasCreated ? "" : " (alias already existed)"),
      );
      setGroups((prev) => prev.filter((x) => x.key !== g.key));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(null);
    }
  }

  if (loading) return <div className="p-10 text-center text-slate-400">Loading…</div>;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-slate-800 flex items-center gap-2">
          <AlertTriangle className="w-5 h-5 text-amber-500" />
          Unresolved messages ({groups.length})
        </h2>
        <p className="text-sm text-slate-500 mt-1 max-w-2xl">
          These are join / drop messages the bot received but couldn&apos;t match to a
          player — usually a WhatsApp display name that&apos;s ambiguous or new
          (e.g. &quot;ba&quot; could be Baki <em>or</em> Başar). Nothing was changed for
          these. Link each name to the right player: that creates a permanent
          alias so it always resolves from now on, and optionally applies the
          drop/join they asked for.
        </p>
      </div>

      {groups.length === 0 ? (
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-6 text-center">
          <Check className="w-6 h-6 text-emerald-600 mx-auto mb-2" />
          <p className="text-emerald-800 font-medium">
            All clear — every attendance message resolved to a player.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {groups.map((g) => (
            <div
              key={g.key}
              className="bg-white rounded-xl border border-slate-200 shadow-sm p-5"
            >
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-base font-semibold text-slate-800">
                      “{g.pushname}”
                    </span>
                    <span className="inline-flex px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 text-xs font-semibold">
                      {INTENT_LABEL[g.lastIntent] ?? g.lastIntent}
                    </span>
                    <span className="text-xs text-slate-400">
                      {g.count} message{g.count === 1 ? "" : "s"} · last{" "}
                      {new Date(g.lastAt).toLocaleString("en-GB", {
                        timeZone: "Europe/London",
                        day: "2-digit",
                        month: "short",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </div>
                  <div className="mt-2 space-y-1">
                    {g.sampleBodies.map((b, i) => (
                      <p
                        key={i}
                        className="text-sm text-slate-600 bg-slate-50 rounded px-2 py-1"
                      >
                        {b}
                      </p>
                    ))}
                  </div>
                </div>
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-4">
                <Link2 className="w-4 h-4 text-slate-400" />
                <span className="text-sm text-slate-600">Link to:</span>
                <select
                  value={pick[g.key] ?? ""}
                  onChange={(e) =>
                    setPick((p) => ({ ...p, [g.key]: e.target.value }))
                  }
                  className="h-9 px-2 rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 max-w-[220px]"
                >
                  <option value="">Choose player…</option>
                  {players
                    .slice()
                    .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""))
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name ?? p.email}
                      </option>
                    ))}
                </select>
                <button
                  disabled={busy === g.key || !pick[g.key]}
                  onClick={() => handleAssign(g, true)}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium"
                  title="Create the alias AND apply the most recent drop/join they asked for"
                >
                  <Check className="w-4 h-4" />
                  Link &amp; apply {g.lastIntent === "in" ? "join" : "drop"}
                </button>
                <button
                  disabled={busy === g.key || !pick[g.key]}
                  onClick={() => handleAssign(g, false)}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 hover:bg-slate-50 disabled:opacity-50 text-slate-700 text-sm font-medium"
                  title="Only create the alias — don't change attendance now"
                >
                  Link only
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
