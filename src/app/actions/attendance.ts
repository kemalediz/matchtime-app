"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { registerAttendance, cancelAttendance } from "@/lib/attendance";
import {
  decideSelfMarkIn,
  isGroupSyncStale,
  groupSyncStaleDays,
  selfMarkInDenialMessage,
} from "@/lib/group-membership-gate";
import { announceOutOfBandAttendance } from "@/lib/out-of-band-announce";
import { revalidatePath } from "next/cache";

export async function attendMatch(matchId: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  // Loophole gate (app self-IN only): only a real member of the org's
  // WhatsApp group may mark THEMSELVES in from the web app. The bot
  // path, in-group guest-adds, and admin add-player all call
  // registerAttendance directly and stay ungated — this check lives
  // here in the server action, not in registerAttendance.
  const match = await db.match.findUnique({
    where: { id: matchId },
    include: { activity: { select: { orgId: true, org: { select: { name: true } } } } },
  });
  if (!match) throw new Error("Match not found");

  const membership = await db.membership.findUnique({
    where: { userId_orgId: { userId: session.user.id, orgId: match.activity.orgId } },
    select: { leftAt: true, lastSeenInGroupAt: true, role: true },
  });

  // Strict pass first. When it allows, or when it denies on something the
  // participant sweep has no say in (no membership at all, or `leftAt`),
  // we are done — and the healthy path pays no extra query.
  let decision = decideSelfMarkIn(membership);

  if (!decision.allowed && decision.reason === "not-in-group") {
    // The only thing standing between this player and the button is a null
    // `lastSeenInGroupAt`. That column has exactly one writer, the bot's
    // startup participant sweep, and that sweep has been failing since
    // 2026-07-07 (MDs/cold-audit-2026-08-31.md). Check whether the signal
    // can still be trusted before telling someone they are not in a group
    // they may well be sitting in.
    //
    // Freshness comes from existing data: the newest sighting anywhere in
    // the org, left members included, because this measures when a SWEEP
    // last succeeded rather than who is on the roster today.
    const newest = await db.membership.aggregate({
      where: { orgId: match.activity.orgId },
      _max: { lastSeenInGroupAt: true },
    });
    const sync = { lastSyncAt: newest._max.lastSeenInGroupAt ?? null, now: new Date() };

    if (isGroupSyncStale(sync)) {
      // Degraded. Look for positive evidence that this person really is in
      // this club's group: a message they posted in the monitored group, or
      // a squad they were already put in by someone who was.
      const [authoredGroupMessages, clubAttendances] = await Promise.all([
        db.analyzedMessage.count({
          where: { orgId: match.activity.orgId, authorUserId: session.user.id },
        }),
        db.attendance.count({
          where: { userId: session.user.id, match: { activity: { orgId: match.activity.orgId } } },
        }),
      ]);
      decision = decideSelfMarkIn(membership, {
        sync,
        evidence: { authoredGroupMessages, clubAttendances },
      });
      console.warn(
        `[attendMatch] participant sync is stale for org ${match.activity.orgId} ` +
          `(${groupSyncStaleDays(sync)} days since the last successful sweep), so the ` +
          "self-IN gate is running degraded and falling back to group-presence evidence. " +
          `user=${session.user.id} authoredGroupMessages=${authoredGroupMessages} ` +
          `clubAttendances=${clubAttendances} decision=${decision.reason} ` +
          `allowed=${decision.allowed}`,
      );
    }
  }

  if (!decision.allowed) {
    throw new Error(selfMarkInDenialMessage(decision.reason, match.activity.org.name));
  }

  // Capture the PRIOR state: registerAttendance is idempotent, so an
  // unchanged status is exactly how we know the tap changed nothing and
  // the group must NOT be told again.
  const priorRow = await db.attendance.findUnique({
    where: { matchId_userId: { matchId, userId: session.user.id } },
    select: { status: true },
  });
  const priorStatus =
    priorRow?.status === "CONFIRMED" ||
    priorRow?.status === "BENCH" ||
    priorRow?.status === "DROPPED"
      ? priorRow.status
      : null;

  const result = await registerAttendance(session.user.id, matchId, {
    // The signed-in player tapping "I'm in" on the web app. Same cause
    // as an IN in the group — the channel is `sourceRef`, not the cause.
    event: {
      cause: "self-attendance",
      actorKind: "player",
      actorUserId: session.user.id,
      sourceRef: "web:attendMatch",
    },
  });

  // OUT-OF-BAND announcement (owner, 2026-08-31): a player marking
  // themselves in on the web app is invisible to the group, so the others
  // keep recruiting or never realise the squad filled. One short line with
  // the post-write squad count, computed in code. Registrations made IN the
  // group are deliberately NOT announced — the group already saw them.
  // Never allowed to break the registration that already succeeded.
  await announceOutOfBandAttendance({
    matchId,
    userId: session.user.id,
    before: priorStatus,
    after: result.status === "BENCH" ? "BENCH" : "CONFIRMED",
    source: "app",
  }).catch((err) => console.error("[attendMatch] group announce failed:", err));

  revalidatePath(`/matches/${matchId}`);
  revalidatePath("/matches");
  revalidatePath("/");
}

export async function dropFromMatch(matchId: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  await cancelAttendance(session.user.id, matchId, {
    cause: "self-attendance",
    actorKind: "player",
    actorUserId: session.user.id,
    sourceRef: "web:dropFromMatch",
  });

  revalidatePath(`/matches/${matchId}`);
  revalidatePath("/matches");
  revalidatePath("/");
}
