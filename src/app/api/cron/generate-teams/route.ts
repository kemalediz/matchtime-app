import { db } from "@/lib/db";
import { balanceTeams, type BalancingStrategy } from "@/lib/team-balancer";
import { PlayerWithRating } from "@/types";
import { NextResponse } from "next/server";
import { sendRatingEmails } from "@/lib/email";
import { format } from "date-fns";
import { computeEloDeltas } from "@/lib/elo";
import { runSquadExtraction } from "@/lib/squad-from-list";

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();

  // ── Daily backstop: squad-from-list extraction ──────────────────
  //   For featureSquadFromList orgs (Amir's shape — derive squad from
  //   pasted lists, see src/lib/squad-from-list.ts), the timely path
  //   runs inline from /api/whatsapp/analyze whenever new messages
  //   arrive within 12h of kickoff. This is the DAILY BACKSTOP for the
  //   case where no messages arrived in that final window (rare but
  //   real: full squad reached early in the week and nobody re-paste
  //   on match day). We can't add a dedicated cron — Vercel plan caps
  //   the project at 3 cron jobs — but generate-teams already runs
  //   daily for matches in flight, so this is the natural piggyback.
  //   Idempotent and falls open on per-org errors.
  try {
    const sqlOrgs = await db.organisation.findMany({
      where: { featureSquadFromList: true, whatsappBotEnabled: true },
      select: { id: true },
    });
    for (const org of sqlOrgs) {
      const upcoming = await db.match.findFirst({
        where: {
          activity: { orgId: org.id },
          status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] },
          date: { gte: new Date(now.getTime() - 60 * 60 * 1000), lte: new Date(now.getTime() + 12 * 60 * 60 * 1000) },
        },
        orderBy: { date: "asc" },
        select: { id: true },
      });
      try {
        await runSquadExtraction({
          orgId: org.id,
          finaliseForMatchId: upcoming?.id,
        });
      } catch (err) {
        console.error(`[generate-teams] squad-from-list backstop failed for org ${org.id}:`, err);
      }
    }
  } catch (err) {
    console.error("[generate-teams] squad-from-list backstop org-list failed:", err);
  }

  // Find matches past deadline that need team generation.
  const matches = await db.match.findMany({
    where: {
      status: "UPCOMING",
      attendanceDeadline: { lte: now },
    },
    include: {
      activity: { include: { sport: true } },
      attendances: {
        where: { status: "CONFIRMED" },
        include: {
          user: {
            include: { activityPositions: true },
          },
        },
      },
    },
  });

  let generated = 0;

  for (const match of matches) {
    const sport = match.activity.sport;
    const perTeam = sport.playersPerTeam;
    if (match.attendances.length < perTeam * 2) continue;

    const players: PlayerWithRating[] = await Promise.all(
      match.attendances.map(async (a) => {
        const ratings = await db.rating.findMany({
          where: { playerId: a.userId },
          orderBy: { createdAt: "desc" },
          take: 60,
        });
        const avgRating =
          ratings.length >= 3
            ? ratings.reduce((sum, r) => sum + r.score, 0) / ratings.length
            : a.user.seedRating ?? 5.0;

        const pap = a.user.activityPositions.find((p) => p.activityId === match.activityId);

        return {
          id: a.userId,
          name: a.user.name ?? "Unknown",
          positions: pap?.positions ?? [],
          rating: avgRating,
          image: a.user.image,
        };
      })
    );

    const composition = sport.positionComposition as Record<string, number> | null;
    const result = balanceTeams({
      players,
      perTeam,
      strategy: sport.balancingStrategy as BalancingStrategy,
      composition: composition ?? undefined,
    });

    await db.teamAssignment.deleteMany({ where: { matchId: match.id } });
    await db.teamAssignment.createMany({
      data: [
        ...result.red.map((p) => ({ matchId: match.id, userId: p.id, team: "RED" as const })),
        ...result.yellow.map((p) => ({ matchId: match.id, userId: p.id, team: "YELLOW" as const })),
      ],
    });

    await db.match.update({
      where: { id: match.id },
      data: { status: "TEAMS_GENERATED" },
    });

    generated++;
  }

  // Auto-publish teams generated more than 1 hour ago.
  const autoPublishCutoff = new Date(now.getTime() - 60 * 60 * 1000);
  const toPublish = await db.match.findMany({
    where: {
      status: "TEAMS_GENERATED",
      updatedAt: { lte: autoPublishCutoff },
    },
  });

  let published = 0;
  for (const match of toPublish) {
    await db.match.update({
      where: { id: match.id },
      data: { status: "TEAMS_PUBLISHED" },
    });
    published++;
  }

  // Auto-complete matches whose duration has expired. Include
  // UPCOMING / TEAMS_GENERATED too — not just TEAMS_PUBLISHED. A
  // MoM+ratings-only group (teamBalancing off) NEVER generates teams,
  // so its match would otherwise sit UPCOMING forever and the
  // post-match flow (MoM poll, rating links — gated on COMPLETED)
  // would never fire (Kemal 2026-05-19: Amir's group). The
  // `now >= matchEndTime` guard below still applies, so a match is
  // only completed once it's genuinely over (kickoff + duration),
  // regardless of whether teams were ever generated.
  const publishedMatches = await db.match.findMany({
    where: {
      status: { in: ["TEAMS_PUBLISHED", "TEAMS_GENERATED", "UPCOMING"] },
      date: { lte: now },
    },
    include: {
      activity: true,
      attendances: {
        where: { status: "CONFIRMED" },
        include: { user: { select: { email: true, name: true } } },
      },
    },
  });

  let completed = 0;
  for (const match of publishedMatches) {
    const matchEndTime = new Date(match.date.getTime() + match.activity.matchDurationMins * 60 * 1000);
    if (now < matchEndTime) continue;

    await db.match.update({
      where: { id: match.id },
      data: { status: "COMPLETED" },
    });

    // Auto-complete without a score = no Elo update yet. Admin enters the
    // score manually via /admin/matches/[id]/teams, which triggers the Elo
    // pass via updateMatchScore. If admin ALSO auto-fills, we'd apply Elo
    // here — but for now, unscored matches stay neutral. This is by design:
    // without knowing who won, there's no outcome signal to learn from.
    if (match.redScore !== null && match.yellowScore !== null) {
      try {
        const teams = await db.teamAssignment.findMany({
          where: { matchId: match.id },
          include: { user: { select: { id: true, matchRating: true } } },
        });
        const deltas = computeEloDeltas(
          teams.map((t) => ({ userId: t.userId, team: t.team, matchRating: t.user.matchRating })),
          match.redScore,
          match.yellowScore,
        );
        await db.$transaction(
          deltas.map((d) =>
            db.user.update({ where: { id: d.userId }, data: { matchRating: d.after } }),
          ),
        );
      } catch (err) {
        console.error("Cron Elo update failed:", err);
      }
    }

    const players = match.attendances.map((a) => ({
      email: a.user.email,
      name: a.user.name,
    }));

    sendRatingEmails(
      match.id,
      match.activity.name,
      format(match.date, "EEEE, d MMMM yyyy"),
      players
    ).catch((err) => console.error("Failed to send rating emails:", err));

    completed++;
  }

  return NextResponse.json({ generated, published, completed });
}
