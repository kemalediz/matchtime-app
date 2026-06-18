import { db } from "./db";
import { requestBenchConfirmationOnDrop, queueSlotEmojiRefresh } from "./bot-scheduler";
import { announceSquadFullIfJustFilled } from "./squad-announce";

export async function registerAttendance(
  userId: string,
  matchId: string,
  options: {
    /** When true, force BENCH regardless of squad capacity. Used when a
     *  player explicitly self-declares "for bench" / "I'll bench" — we
     *  respect their stated intent rather than letting capacity logic
     *  promote them to a confirmed slot they didn't ask for. */
    forceBench?: boolean;
    /** When true, a player CURRENTLY on the bench who says IN gets
     *  promoted to CONFIRMED if there's a free slot (squad < max).
     *  This is set ONLY for the player's OWN claim ("IN" from the
     *  bencher themselves) — NOT for third-party registerFor. Kemal
     *  2026-05-19: a benched player saying IN while the squad is short
     *  must move to the squad; but a random member saying "Burak
     *  should come" must NOT promote Burak (he didn't ask). Default
     *  false preserves the old idempotent behaviour. */
    promoteFromBench?: boolean;
  } = {},
) {
  const match = await db.match.findUnique({
    where: { id: matchId },
    include: { activity: { select: { orgId: true } } },
  });
  if (!match) throw new Error("Match not found");

  // Deadline check removed 2026-05-06 (Kemal's call): players can
  // register all the way up to match completion. Late INs on a full
  // squad just go to the bench — the squad-capacity logic below
  // handles that. Once the match is COMPLETED or CANCELLED the
  // analyze route's findRegistrationMatch returns null so we never
  // get here in the first place.
  //
  // BUT: block registrations for a FUTURE match while a previous
  // scheduled match in the same org is still in flight (UPCOMING/
  // TEAMS_GENERATED/TEAMS_PUBLISHED with date < today). This stops
  // the dashboard's "I'm in" button on next week's match from
  // working before this week's match has been completed by the
  // cron. Without this guard, the same race that bit the WhatsApp
  // analyzer (Kemal/Izzet/Baki silently registered for the May 12
  // match minutes after the May 5 match-day deadline) would happen
  // again via the UI. Mirrors the rule in
  // analyze/route.ts:findRegistrationMatch.
  {
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    if (match.date >= todayStart) {
      const inFlight = await db.match.findFirst({
        where: {
          activity: { orgId: match.activity.orgId },
          status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] },
          date: { lt: todayStart },
          id: { not: matchId },
        },
        select: { id: true, date: true },
      });
      if (inFlight) {
        throw new Error(
          `Previous match (${inFlight.date.toISOString().slice(0, 10)}) hasn't been completed yet — can't register for the next one yet.`,
        );
      }
    }
  }

  // Idempotency: if the user is already CONFIRMED or BENCH for this
  // match, don't touch position/status — UNLESS the new request is an
  // explicit forceBench AND they're currently CONFIRMED. That means
  // they retroactively want bench (e.g. "actually put me on bench").
  const existing = await db.attendance.findUnique({
    where: { matchId_userId: { matchId, userId } },
  });
  // True when this call is a bench player's OWN claim ("IN") that filled a
  // free slot — used below to resolve the dangling open BenchSlotOffer.
  let selfPromoted = false;
  if (existing && (existing.status === "CONFIRMED" || existing.status === "BENCH")) {
    const wantsBenchDowngrade =
      options.forceBench === true && existing.status === "CONFIRMED";
    // A benched player claiming a spot ("IN") when the squad has room
    // must be PROMOTED — not idempotently ignored. Only for their own
    // claim (promoteFromBench), never a third-party registerFor, and
    // never when they explicitly asked for bench (forceBench).
    let wantsBenchPromotion = false;
    if (
      existing.status === "BENCH" &&
      options.promoteFromBench === true &&
      options.forceBench !== true
    ) {
      const confirmedNow = await db.attendance.count({
        where: { matchId, status: "CONFIRMED" },
      });
      if (confirmedNow < match.maxPlayers) wantsBenchPromotion = true;
    }
    selfPromoted = wantsBenchPromotion;
    if (!wantsBenchDowngrade && !wantsBenchPromotion) {
      const all = await db.attendance.findMany({
        where: { matchId, status: { in: ["CONFIRMED", "BENCH"] } },
        orderBy: { position: "asc" },
      });
      const confirmed = all.filter((a) => a.status === "CONFIRMED");
      const bench = all.filter((a) => a.status === "BENCH");
      const slot =
        existing.status === "CONFIRMED"
          ? confirmed.findIndex((a) => a.userId === userId) + 1
          : bench.findIndex((a) => a.userId === userId) + 1;
      return {
        status: existing.status,
        position: existing.position,
        slot,
        confirmedCount: confirmed.length,
        maxPlayers: match.maxPlayers,
      };
    }
  }

  const maxPos = await db.attendance.aggregate({
    where: { matchId },
    _max: { position: true },
  });
  const nextPosition = (maxPos._max.position ?? 0) + 1;

  const confirmedCount = await db.attendance.count({
    where: { matchId, status: "CONFIRMED" },
  });
  const benchCount = await db.attendance.count({
    where: { matchId, status: "BENCH" },
  });

  const status = options.forceBench
    ? "BENCH"
    : confirmedCount < match.maxPlayers
      ? "CONFIRMED"
      : "BENCH";

  // For an existing CONFIRMED row downgrading to BENCH, keep their
  // existing position so we don't shuffle the slot list.
  const positionToWrite =
    existing && options.forceBench && existing.status === "CONFIRMED"
      ? existing.position
      : nextPosition;

  const attendance = await db.attendance.upsert({
    where: { matchId_userId: { matchId, userId } },
    create: { matchId, userId, status, position: positionToWrite },
    update: { status, position: positionToWrite, respondedAt: new Date() },
  });

  // ── Auto-resolve any open BenchSlotOffer for this user (2026-05-26) ──
  // If we just re-CONFIRMED / re-BENCHED a user who was previously
  // DROPPED, any open BenchSlotOffer where they were `replacingUserId`
  // is now stale — the slot they vacated isn't vacant anymore, so
  // asking the bench to step up for it makes no sense. The scheduler
  // keeps emitting bench-prompts for unresolved offers forever; if we
  // don't close them here the bot looks confused (Sutton 2026-05-26:
  // Baki was re-CONFIRMED in admin after his earlier drop, but the
  // open offer for his slot kept firing bench prompts on top of the
  // squad-locked message).
  if (
    existing?.status === "DROPPED" &&
    (status === "CONFIRMED" || status === "BENCH")
  ) {
    try {
      const closed = await db.benchSlotOffer.updateMany({
        where: { matchId, replacingUserId: userId, resolvedAt: null },
        data: { resolvedAt: new Date() },
      });
      if (closed.count > 0) {
        console.log(
          `[attendance] auto-resolved ${closed.count} stale BenchSlotOffer(s) for user ${userId} re-${status} on match ${matchId}`,
        );
      }
    } catch (err) {
      console.error("[attendance] auto-resolve BenchSlotOffer failed:", err);
    }
  }

  // ── Resolve open BenchSlotOffer(s) when this confirm fills the squad ─────
  // Whenever a registration RESULTS IN the squad becoming full (the last open
  // slot is taken), any open offer for this match is now moot — there is no
  // longer a vacant slot for the bench to step up into. Close every open
  // offer so the scheduler stops emitting "asking the bench" prompts and the
  // analyze route's overconfident-promotion rewrite doesn't treat the now-
  // full squad as still short.
  //
  // This must fire for ANY joiner who grabs the last slot — NOT just a bench
  // self-promotion (`selfPromoted`). The original bug (2026-06): a player on
  // NEITHER the squad nor the bench (a general group member, or an auto-
  // provisioned user from an unresolved @lid) says IN, takes the final slot,
  // squad goes full — but the offer-close used to be gated on `selfPromoted`
  // (which requires an existing BENCH row), so an off-list joiner left the
  // offer dangling. We decouple the close from `selfPromoted`: trigger on
  // "this confirm just completed the squad" instead.
  //
  // Guards: only on a GENUINE new confirm (CONFIRMED + not already CONFIRMED)
  // AND only when the squad is now actually full — never on an OUT, never
  // while open slots remain. We re-count CONFIRMED after the write so a
  // partial fill (slots still open) leaves the offer open for the bench.
  const isFreshConfirm = status === "CONFIRMED" && existing?.status !== "CONFIRMED";
  if (isFreshConfirm) {
    try {
      const confirmedNow = await db.attendance.count({
        where: { matchId, status: "CONFIRMED" },
      });
      if (confirmedNow >= match.maxPlayers) {
        // Squad full. Close the OLDEST open offer as "claimed" by this user
        // (mirrors resolveBenchConfirmation — the joiner effectively took the
        // slot the offer was advertising), and close any other stragglers so
        // none dangle. `claimedByUserId` is set only on the one this joiner
        // claimed; extra offers (rare) close without a claimant.
        const now = new Date();
        const oldest = await db.benchSlotOffer.findFirst({
          where: { matchId, resolvedAt: null },
          orderBy: { createdAt: "asc" },
        });
        if (oldest) {
          const claim = await db.benchSlotOffer.updateMany({
            where: { id: oldest.id, resolvedAt: null },
            data: { resolvedAt: now, claimedByUserId: userId, outcome: "claimed" },
          });
          // Sweep any remaining open offers for this now-full match.
          const swept = await db.benchSlotOffer.updateMany({
            where: { matchId, resolvedAt: null },
            data: { resolvedAt: now, outcome: "claimed" },
          });
          if (claim.count > 0 || swept.count > 0) {
            console.log(
              `[attendance] squad-full close: resolved ${claim.count + swept.count} open BenchSlotOffer(s) for match ${matchId} (last slot taken by user ${userId}, selfPromoted=${selfPromoted})`,
            );
          }
        }
      }
    } catch (err) {
      console.error("[attendance] squad-full offer-resolve failed:", err);
    }
  }

  // Friendly "slot" the bot uses for its reaction emoji. If the player
  // made the squad, their slot is their 1-indexed place in the squad
  // (equals the new confirmed count). If they landed on the bench, it's
  // their 1-indexed bench slot.
  const slot =
    status === "CONFIRMED" ? confirmedCount + 1 : benchCount + 1;

  // If we forced BENCH on a previously-confirmed user, slots may have
  // shifted up for others — refresh emojis like cancelAttendance does.
  if (existing?.status === "CONFIRMED" && status === "BENCH") {
    await queueSlotEmojiRefresh(matchId);
  }

  // The moment this confirm completes the squad, announce it with the
  // full line-up. Idempotent + atomic — safe to call from every
  // confirm path (plain IN, bench promotion, third-party registerFor);
  // it self-dedupes per fill cycle.
  if (status === "CONFIRMED" && existing?.status !== "CONFIRMED") {
    await announceSquadFullIfJustFilled(matchId).catch((err) =>
      console.error("[attendance] squad-full announce failed:", err),
    );
  }

  return {
    status: attendance.status,
    position: attendance.position,
    slot,
    confirmedCount:
      confirmedCount + (status === "CONFIRMED" && existing?.status !== "CONFIRMED" ? 1 : 0) -
      (existing?.status === "CONFIRMED" && status === "BENCH" ? 1 : 0),
    maxPlayers: match.maxPlayers,
  };
}

export async function cancelAttendance(userId: string, matchId: string) {
  const match = await db.match.findUnique({ where: { id: matchId } });
  if (!match) throw new Error("Match not found");

  // Deadline check removed 2026-05-06 — symmetric with
  // registerAttendance. Players can drop all the way to kickoff;
  // late OUTs trigger the bench-promote chain regardless of how
  // close to kickoff the drop happens.

  const attendance = await db.attendance.findUnique({
    where: { matchId_userId: { matchId, userId } },
  });

  if (!attendance) throw new Error("Not attending this match");

  const wasConfirmed = attendance.status === "CONFIRMED";

  await db.attendance.update({
    where: { id: attendance.id },
    data: { status: "DROPPED" },
  });

  // If someone in the confirmed 14 dropped, we DON'T auto-promote any more.
  // Instead we ask the first bench player via WhatsApp 👍/👎 first (they
  // may have mentally checked out). The bot-scheduler creates a
  // PendingBenchConfirmation; subsequent /due-posts cycles post the prompt
  // and handle confirmation/timeout.
  if (wasConfirmed) {
    // Re-arm the "squad full" announcement. It dedupes on
    // `<matchId>:squad-locked` (once per match) — but a squad can
    // legitimately go full → drop → re-fill several times in a
    // chaotic week. Without clearing the dedupe, only the FIRST fill
    // ever gets announced and every later re-completion is silent
    // (Kemal 2026-05-19: Enayem completed 14/14 but the group was
    // never told because squad-locked fired days earlier with a
    // different line-up). Deleting it on a confirmed-drop lets the
    // next re-fill announce again.
    await db.sentNotification
      .deleteMany({ where: { key: `${matchId}:squad-locked` } })
      .catch(() => {});
    // Pass the dropped user's id so the bench-prompt knows which team
    // slot is being filled. On 👍 the reaction handler will transfer
    // this user's TeamAssignment to the bench player and announce the
    // swap to the group.
    await requestBenchConfirmationOnDrop(matchId, userId);
    // Slots have shifted up — queue retroactive react updates so
    // every confirmed player's IN message shows their NEW slot emoji.
    // Idempotent and bounded; bot picks them up on its next 5-min tick.
    await queueSlotEmojiRefresh(matchId);
  }

  return { status: "DROPPED" as const };
}
