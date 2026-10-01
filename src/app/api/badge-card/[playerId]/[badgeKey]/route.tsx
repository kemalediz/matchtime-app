/**
 * Badge share card (Kemal, 2026-10-01): one EARNED badge as a square PNG
 * via next/og (Satori), shared from /profile/stats straight into
 * WhatsApp. Same visual family and the same public-by-cuid model as the
 * Wrapped card (`/api/wrapped/[playerId]`).
 *
 *   GET /api/badge-card/<playerId>/<badgeKey>?org=<orgId>
 *
 * 404 unless the player has EARNED that badge at that club and is still
 * a member there. The card shows only the badge, what it means, the
 * player's name and the club's name: never a rating or a seed. All of
 * that is enforced by `loadEarnedBadgeCard` (src/lib/badge-card.ts),
 * the only data this route reads.
 *
 * Satori supports flexbox + a subset of CSS only, NO grid. Every
 * container with more than one child sets display:flex explicitly.
 */

import { ImageResponse } from "next/og";
import { loadEarnedBadgeCard } from "@/lib/badge-card";

export const dynamic = "force-dynamic";

const SIZE = 1080;

export async function GET(
  req: Request,
  { params }: { params: Promise<{ playerId: string; badgeKey: string }> },
) {
  const { playerId, badgeKey } = await params;
  const orgId = new URL(req.url).searchParams.get("org");
  if (!orgId) return new Response("Not found", { status: 404 });

  const card = await loadEarnedBadgeCard(orgId, playerId, badgeKey);
  if (!card) return new Response("Not found", { status: 404 });

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
        {/* Brand row, as on the Wrapped card */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", fontSize: 34, fontWeight: 700 }}>
            ⚽ MatchTime
          </div>
          <div style={{ display: "flex", fontSize: 28, color: "#93c5fd", maxWidth: 560 }}>
            {card.orgName}
          </div>
        </div>

        {/* The badge */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            flex: 1,
            justifyContent: "center",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 340,
              height: 340,
              borderRadius: 170,
              background: "rgba(255,255,255,0.08)",
              border: "6px solid #fbbf24",
              fontSize: 190,
            }}
          >
            {card.badge.emoji}
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 28,
              fontWeight: 700,
              letterSpacing: 6,
              color: "#fbbf24",
              marginTop: 40,
            }}
          >
            BADGE EARNED
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 92,
              fontWeight: 800,
              marginTop: 8,
              textAlign: "center",
              maxWidth: 920,
            }}
          >
            {card.badge.label}
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 40,
              color: "#cbd5e1",
              marginTop: 12,
              textAlign: "center",
              maxWidth: 880,
            }}
          >
            {card.badge.hint}
          </div>
        </div>

        {/* Player + small branding */}
        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between" }}>
          <div style={{ display: "flex", fontSize: 52, fontWeight: 800, maxWidth: 700 }}>
            {card.playerName}
          </div>
          <div style={{ display: "flex", fontSize: 28, color: "#93c5fd" }}>matchtime.ai</div>
        </div>
      </div>
    ),
    {
      width: SIZE,
      height: SIZE,
      headers: {
        "Cache-Control": "public, max-age=300, s-maxage=300",
      },
    },
  );
}
