"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { requireOrgAdmin } from "@/lib/org";
import { recordAttendanceEvent } from "@/lib/attendance-events";
import {
  generateTeamsForMatch,
  type GenerateTeamsOptions,
} from "@/lib/team-generation";
import { revalidatePath } from "next/cache";

/**
 * ── TOMBSTONE: THE SECOND RATING FORMULA (deleted 2026-09-15) ────────
 *
 * This file used to own a private `getPlayerRating`, and the admin
 * dashboard's Generate button was the only caller:
 *
 *     eloScaled = user.matchRating / 200            // 1000 → 5.0
 *     peers >= 3 ? 0.5 * peerAvg + 0.5 * eloScaled
 *                : 0.7 * seedRating + 0.3 * eloScaled
 *
 * `lib/team-generation.ts` is the path a WhatsApp "@Match Time generate
 * the teams" takes, and the path that had in fact built every recent
 * Sutton team sheet. It used the seed-and-peer blend instead (today's
 * `computeClubRating`): `(sumPeer + prior * 3) / (peerCount + 3)`,
 * with the Elo not consulted at all.
 *
 * So MatchTime had two buttons that meant "build the teams" and they
 * disagreed, and nobody could tell which sheet they were looking at.
 * The divergence was wider than the number: the dashboard also skipped
 * the LLM rating adjuster, ignored `pinnedToTeam` (the "put me on Red"
 * request), ignored `teamNames`, and carried its own copy of the
 * deleteMany → createMany → status write.
 *
 * Kemal, 2026-09-15: "what you explained above for team generation
 * which was blended should be the one used for team generation
 * everywhere." The blended one is `computeClubRating` (it was
 * `computePlayerRating` until the ratings became club-scoped).
 *
 * WHAT THE OLD FORMULA WAS ACTUALLY DOING, measured on the live Sutton
 * squad the day it was deleted (`scripts/compare-rating-formulas.ts`):
 * it promoted the high-Elo players up the draft and buried the low-Elo
 * ones regardless of what their team-mates thought of them.
 * Mojib (Elo 1072) went 6th → 2nd, Najib (1048) 9th → 6th, Karahan
 * (1044) 13th → 10th; Idris (Elo 879, blended 6.98) fell 5th → 12th.
 * It also COMPRESSED the squad — spread 2.49 → 1.37 — because half the
 * weight sat on an Elo still clustered near its 1000 starting value.
 *
 * ── WHY THE ACTION DELEGATES INSTEAD OF COPYING THE FORMULA ──────────
 *
 * Matching only the number would have left two implementations that
 * happen to agree today and drift the next time either is touched, and
 * it would NOT have fixed the adjuster, the pins, the names or the
 * duplicated write. The two paths a human can trigger, the WhatsApp
 * command and this button, now share one implementation, and this
 * action is a thin, authenticated door into it. The rule for anything
 * added here later: if it changes WHO IS ON WHICH TEAM, it belongs in
 * `lib/team-generation.ts`, not in this file.
 *
 * ── ONE RIVAL FORMULA IS STILL STANDING, AND THIS IS NOT IT ──────────
 *
 * `app/api/cron/generate-teams/route.ts:57-92` computes its own rating
 * inline (`ratings.length >= 3 ? mean of the last 60 peer scores :
 * seedRating ?? 5.0`), calls `balanceTeams`, writes `TeamAssignment`
 * rows and flips `Match.status`, and `vercel.json` schedules it live at
 * `0 12 * * *`. It never calls `generateTeamsForMatch`. There were
 * THREE implementations before this change and there are two after it,
 * so do not read the paragraph above as "nothing else picks teams".
 * Slice 3 of `MDs/club-scoped-ratings-design-2026-09-18.md` deletes
 * that formula and makes the cron delegate to the shared helper; it is
 * deliberately out of scope here.
 *
 * The Elo is not deleted and did not lose a job. It still updates after
 * every scored match and still drives the leaderboard. It simply has no
 * say in team selection — which was already true on the WhatsApp path,
 * and is now true uniformly instead of true on one path only. See the
 * note at the top of `lib/elo.ts`.
 */

/**
 * Build the team sheet from the admin dashboard.
 *
 * Authenticates, checks the admin seat, then hands off to the shared
 * implementation. Three things are deliberate:
 *
 *  1. AUTH FIRST, THEN THE ADMIN SEAT, THEN DELEGATE.
 *     `generateTeamsForMatch` has no authorisation of its own. Its only
 *     other caller, the analysed-message pipeline, is a trusted context
 *     that authorised earlier. This action is reachable
 *     from a browser, so it keeps both checks, in this order, ahead of
 *     every read and write.
 *
 *  2. THE GROUP POST IS DROPPED ON THE FLOOR.
 *     `generateTeamsForMatch` RETURNS the ready-to-post line-up; it does
 *     not queue it. Nothing in it writes a `BotJob` — posting is always
 *     the caller's decision, and the WhatsApp route is the caller that
 *     makes it. An admin pressing a dashboard button has not asked the
 *     club to be told, so this one discards the string. If that ever
 *     becomes desirable it must be a separate, explicit control (the
 *     Publish button is the existing one), never a side effect of
 *     Generate. `__tests__/team-generation-one-path.test.ts` asserts
 *     zero BotJob rows.
 *
 *  3. THE RETURN SHAPE IS TRANSLATED, NOT PASSED THROUGH.
 *     The helper returns `{ ok: false, reason }`; the admin page does
 *     `try { await generateTeams(...) } catch (e) { toast.error(
 *     e.message) }`. So a refusal is re-thrown as an Error carrying the
 *     helper's reason, which is written to be read by a human ("not
 *     enough confirmed players — 9/14").
 */
export async function generateTeams(
  matchId: string,
  opts: GenerateTeamsOptions = {},
) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  // Read only what the admin gate needs. The helper re-reads the match
  // with the squad, the sport and the org it needs — one extra query,
  // and the alternative is passing a half-loaded row into a function
  // whose other callers load it themselves.
  const match = await db.match.findUnique({
    where: { id: matchId },
    select: { activity: { select: { orgId: true } } },
  });
  if (!match) throw new Error("Match not found");

  await requireOrgAdmin(session.user.id, match.activity.orgId);

  const result = await generateTeamsForMatch(matchId, opts);
  if (!result.ok) throw new Error(result.reason);

  revalidatePath(`/matches/${matchId}`);
  revalidatePath(`/admin/matches/${matchId}/teams`);
}

export async function swapPlayers(matchId: string, playerId1: string, playerId2: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  const match = await db.match.findUnique({
    where: { id: matchId },
    include: { activity: true },
  });
  if (!match) throw new Error("Match not found");

  await requireOrgAdmin(session.user.id, match.activity.orgId);

  const assignment1 = await db.teamAssignment.findUnique({
    where: { matchId_userId: { matchId, userId: playerId1 } },
  });
  const assignment2 = await db.teamAssignment.findUnique({
    where: { matchId_userId: { matchId, userId: playerId2 } },
  });

  if (!assignment1 || !assignment2) throw new Error("Players not assigned to teams");
  if (assignment1.team === assignment2.team) throw new Error("Players are on the same team");

  await db.teamAssignment.update({
    where: { id: assignment1.id },
    data: { team: assignment2.team },
  });
  await db.teamAssignment.update({
    where: { id: assignment2.id },
    data: { team: assignment1.team },
  });

  revalidatePath(`/matches/${matchId}`);
  revalidatePath(`/admin/matches/${matchId}/teams`);
}

/**
 * Flip the team labels — every RED becomes YELLOW and vice-versa — keeping
 * the exact same player groupings. One-click colour swap so admins never
 * need a DB edit for "swap the colours, keep the same teams" (Kemal
 * 2026-06-09). Mirrors the bot's handleColorSwapIfApplicable.
 */
export async function swapTeamColours(matchId: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  const match = await db.match.findUnique({ where: { id: matchId }, include: { activity: true } });
  if (!match) throw new Error("Match not found");
  await requireOrgAdmin(session.user.id, match.activity.orgId);

  const assignments = await db.teamAssignment.findMany({ where: { matchId } });
  await db.$transaction(
    assignments.map((a) =>
      db.teamAssignment.update({
        where: { id: a.id },
        data: { team: a.team === "RED" ? "YELLOW" : "RED" },
      }),
    ),
  );
  revalidatePath(`/matches/${matchId}`);
  revalidatePath(`/admin/matches/${matchId}/teams`);
}

/**
 * Move a single player to the other team. Lets an admin build any line-up
 * by hand (no rebalance) — combined with the page's two-player swap, this
 * covers arbitrary corrections without DB surgery.
 */
export async function movePlayerToOtherTeam(matchId: string, userId: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  const match = await db.match.findUnique({ where: { id: matchId }, include: { activity: true } });
  if (!match) throw new Error("Match not found");
  await requireOrgAdmin(session.user.id, match.activity.orgId);

  const a = await db.teamAssignment.findUnique({
    where: { matchId_userId: { matchId, userId } },
  });
  if (!a) throw new Error("Player isn't assigned to a team");
  await db.teamAssignment.update({
    where: { id: a.id },
    data: { team: a.team === "RED" ? "YELLOW" : "RED" },
  });
  revalidatePath(`/matches/${matchId}`);
  revalidatePath(`/admin/matches/${matchId}/teams`);
}

/** Put a confirmed player onto a team (or move them to a specific side).
 *  Used to slot a replacement/bench player into the line-up after a drop,
 *  without regenerating. */
export async function addToTeam(matchId: string, userId: string, team: "RED" | "YELLOW") {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  const match = await db.match.findUnique({ where: { id: matchId }, include: { activity: true } });
  if (!match) throw new Error("Match not found");
  await requireOrgAdmin(session.user.id, match.activity.orgId);

  await db.teamAssignment.upsert({
    where: { matchId_userId: { matchId, userId } },
    create: { matchId, userId, team },
    update: { team },
  });
  revalidatePath(`/matches/${matchId}`);
  revalidatePath(`/admin/matches/${matchId}/teams`);
}

/** Remove a player from the teams entirely — e.g. they dropped after teams
 *  were generated and are still showing in a slot. */
export async function removeFromTeam(matchId: string, userId: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  const match = await db.match.findUnique({ where: { id: matchId }, include: { activity: true } });
  if (!match) throw new Error("Match not found");
  await requireOrgAdmin(session.user.id, match.activity.orgId);

  await db.teamAssignment.deleteMany({ where: { matchId, userId } });
  revalidatePath(`/matches/${matchId}`);
  revalidatePath(`/admin/matches/${matchId}/teams`);
}

/**
 * Promote a bench player into the playing squad and onto a team — sets
 * their attendance to CONFIRMED and assigns them to `team`. This is the
 * "move up from bench" admin action (Kemal 2026-06-09: a bench player like
 * Enayem couldn't be slotted in from any admin screen). Dedicated action
 * so the plain addToTeam/removeFromTeam keep their existing behaviour.
 */
export async function promoteFromBench(matchId: string, userId: string, team: "RED" | "YELLOW") {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  const match = await db.match.findUnique({ where: { id: matchId }, include: { activity: true } });
  if (!match) throw new Error("Match not found");
  await requireOrgAdmin(session.user.id, match.activity.orgId);

  const priorRow = await db.attendance.findUnique({
    where: { matchId_userId: { matchId, userId } },
    select: { status: true, position: true },
  });
  // Same transaction as the record of it — see lib/attendance-events.ts.
  // Only the squad place is logged; the TeamAssignment below is a
  // different fact (which shirt), not a squad place, and has its own row.
  await db.$transaction(async (tx) => {
    const row = await tx.attendance.upsert({
      where: { matchId_userId: { matchId, userId } },
      create: { matchId, userId, status: "CONFIRMED" },
      update: { status: "CONFIRMED" },
    });
    await recordAttendanceEvent(
      tx,
      {
        matchId,
        userId,
        orgId: match.activity.orgId,
        fromStatus: priorRow?.status ?? null,
        toStatus: row.status,
        fromPosition: priorRow?.position ?? null,
        toPosition: row.position,
      },
      {
        cause: "admin-squad-edit",
        actorKind: "admin",
        actorUserId: session.user!.id,
        sourceRef: "admin:promoteFromBench",
        note: `promoted into the squad and onto ${team}`,
      },
    );
  });
  await db.teamAssignment.upsert({
    where: { matchId_userId: { matchId, userId } },
    create: { matchId, userId, team },
    update: { team },
  });
  revalidatePath(`/matches/${matchId}`);
  revalidatePath(`/admin/matches/${matchId}/teams`);
}

export async function publishTeams(matchId: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  const match = await db.match.findUnique({
    where: { id: matchId },
    include: { activity: true },
  });
  if (!match) throw new Error("Match not found");

  await requireOrgAdmin(session.user.id, match.activity.orgId);

  await db.match.update({
    where: { id: matchId },
    data: { status: "TEAMS_PUBLISHED" },
  });

  revalidatePath(`/matches/${matchId}`);
  revalidatePath("/matches");
}
