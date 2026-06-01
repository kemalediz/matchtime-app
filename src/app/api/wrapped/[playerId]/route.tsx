/**
 * "MatchTime Wrapped" — a shareable season-recap card rendered as a PNG
 * via next/og (Satori). Designed to be screenshotted / shared straight
 * into the WhatsApp group, so it's intentionally public-by-cuid: it
 * shows only aggregate season stats (avg rating, MoM count, record) —
 * the same data the bot already posts to the group as leaderboards.
 *
 * Org scope: ?org=<orgId> (passed by /profile/stats). Falls back to the
 * player's first active membership when omitted.
 *
 * Satori supports flexbox + a subset of CSS only — NO grid. Every
 * container with >1 child sets display:flex explicitly.
 */

import { ImageResponse } from "next/og";
import { db } from "@/lib/db";
import { loadPlayerSeasonStats } from "@/lib/player-stats";

export const dynamic = "force-dynamic";

const W = 1080;
const H = 1350;

export async function GET(
  req: Request,
  { params }: { params: Promise<{ playerId: string }> },
) {
  const { playerId } = await params;
  const url = new URL(req.url);
  let orgId = url.searchParams.get("org");

  if (!orgId) {
    const m = await db.membership.findFirst({
      where: { userId: playerId, leftAt: null },
      select: { orgId: true },
    });
    orgId = m?.orgId ?? null;
  }
  if (!orgId) {
    return new Response("No org for player", { status: 404 });
  }

  const s = await loadPlayerSeasonStats(orgId, playerId);
  if (!s) return new Response("Not found", { status: 404 });

  const firstName = s.player.name?.split(" ")[0] ?? "Player";
  const vs = s.vsFieldPct;
  const topBadge = s.badges.filter((b) => b.earned).slice(-1)[0];
  const formLabel =
    s.form.trend === "hot" ? "🔥 On fire" : s.form.trend === "cold" ? "❄️ Cold" : "➡️ Steady";

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          background: "linear-gradient(160deg, #0f172a 0%, #1e3a8a 60%, #1e40af 100%)",
          color: "white",
          padding: 64,
          fontFamily: "sans-serif",
        }}
      >
        {/* Brand */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", fontSize: 34, fontWeight: 700 }}>
            ⚽ MatchTime
          </div>
          <div style={{ display: "flex", fontSize: 28, color: "#93c5fd" }}>{s.orgName}</div>
        </div>

        <div style={{ display: "flex", fontSize: 30, color: "#cbd5e1", marginTop: 40 }}>
          Season so far
        </div>
        <div style={{ display: "flex", fontSize: 86, fontWeight: 800, marginTop: 4 }}>
          {firstName}
        </div>

        {/* Hero rating */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            marginTop: 40,
            padding: 36,
            background: "rgba(255,255,255,0.08)",
            borderRadius: 36,
          }}
        >
          <div style={{ display: "flex", fontSize: 28, color: "#93c5fd" }}>AVERAGE RATING</div>
          <div style={{ display: "flex", fontSize: 150, fontWeight: 800, lineHeight: 1 }}>
            {s.avgRating?.toFixed(1) ?? "—"}
          </div>
          {vs !== null && (
            <div
              style={{
                display: "flex",
                fontSize: 34,
                color: vs >= 0 ? "#4ade80" : "#fca5a5",
                marginTop: 8,
              }}
            >
              {vs >= 0 ? "▲" : "▼"} {Math.abs(vs).toFixed(0)}% vs squad average
            </div>
          )}
        </div>

        {/* Stat row */}
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 44 }}>
          <Stat big={`${s.momCount}`} label="🏆 MoM" />
          <Stat big={`${s.gamesPlayed}`} label="👟 Games" />
          <Stat big={`${s.record.w}-${s.record.d}-${s.record.l}`} label="W-D-L" />
        </div>

        <div style={{ display: "flex", flexDirection: "column", marginTop: 48, flex: 1, justifyContent: "flex-end" }}>
          <div style={{ display: "flex", fontSize: 32, color: "#cbd5e1" }}>
            {formLabel} · last 5: {s.form.last5Avg?.toFixed(1) ?? "—"}
          </div>
          {topBadge && (
            <div style={{ display: "flex", fontSize: 38, fontWeight: 700, marginTop: 12 }}>
              {topBadge.emoji} {topBadge.label}
            </div>
          )}
          {s.bestGame && (
            <div style={{ display: "flex", fontSize: 28, color: "#93c5fd", marginTop: 12 }}>
              Best game: {s.bestGame.label} — {s.bestGame.avg.toFixed(1)} ⭐
            </div>
          )}
        </div>
      </div>
    ),
    {
      width: W,
      height: H,
      headers: {
        "Cache-Control": "public, max-age=300, s-maxage=300",
      },
    },
  );
}

function Stat({ big, label }: { big: string; label: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
      <div style={{ display: "flex", fontSize: 72, fontWeight: 800 }}>{big}</div>
      <div style={{ display: "flex", fontSize: 26, color: "#cbd5e1", marginTop: 4 }}>{label}</div>
    </div>
  );
}
