/**
 * Bot posts here when a reaction arrives on a tracked message (currently
 * just bench-prompt messages). We resolve the corresponding
 * PendingBenchConfirmation and update attendance accordingly.
 *
 * 👍 from the right user → promote to CONFIRMED
 * 👎 from the right user → mark DROPPED (their own "pass"), trigger next bench
 * Any reaction from a different user is ignored.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { normalisePhone } from "@/lib/phone";
import { requestBenchConfirmationOnDrop } from "@/lib/bot-scheduler";

export async function POST(request: Request) {
  const apiKey = request.headers.get("x-api-key");
  if (apiKey !== process.env.WHATSAPP_API_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { waMessageId, emoji, fromPhone } = body as {
    waMessageId: string;
    emoji: string;
    fromPhone: string;
  };
  if (!waMessageId || !emoji || !fromPhone) {
    return NextResponse.json({ error: "waMessageId, emoji, fromPhone required" }, { status: 400 });
  }

  const bc = await db.pendingBenchConfirmation.findFirst({
    where: { waMessageId, resolvedAt: null },
    include: { match: true },
  });
  if (!bc) return NextResponse.json({ ok: true, ignored: "no-pending-confirmation" });

  const normalised = normalisePhone(fromPhone);
  if (!normalised) return NextResponse.json({ ok: true, ignored: "bad-phone" });

  const user = await db.user.findUnique({ where: { phoneNumber: normalised } });
  if (!user || user.id !== bc.userId) {
    // Someone else reacted — ignore. Only the bench user's own reaction counts.
    return NextResponse.json({ ok: true, ignored: "wrong-user" });
  }

  const isYes = emoji === "👍" || emoji === "👍🏻" || emoji === "👍🏼" || emoji === "👍🏽" || emoji === "👍🏾" || emoji === "👍🏿";
  const isNo = emoji === "👎" || emoji === "👎🏻" || emoji === "👎🏼" || emoji === "👎🏽" || emoji === "👎🏾" || emoji === "👎🏿";

  if (!isYes && !isNo) {
    return NextResponse.json({ ok: true, ignored: "not-yes-no" });
  }

  if (isYes) {
    // Step 1 (always): mark PBC confirmed and promote attendance.
    await db.$transaction([
      db.pendingBenchConfirmation.update({
        where: { id: bc.id },
        data: { resolvedAt: new Date(), outcome: "confirmed" },
      }),
      db.attendance.update({
        where: { matchId_userId: { matchId: bc.matchId, userId: bc.userId } },
        data: { status: "CONFIRMED" },
      }),
    ]);

    // Step 2 (when teams already exist): transfer the dropped
    // player's TeamAssignment to this bench user. Wrapped in its
    // own try so any failure here never reverts the attendance
    // promotion above.
    let teamSwap: { teamLabel: string } | null = null;
    if (bc.replacingUserId) {
      try {
        const droppedTA = await db.teamAssignment.findUnique({
          where: {
            matchId_userId: { matchId: bc.matchId, userId: bc.replacingUserId },
          },
        });
        if (droppedTA) {
          await db.$transaction([
            db.teamAssignment.delete({
              where: {
                matchId_userId: {
                  matchId: bc.matchId,
                  userId: bc.replacingUserId,
                },
              },
            }),
            db.teamAssignment.upsert({
              where: {
                matchId_userId: { matchId: bc.matchId, userId: bc.userId },
              },
              create: {
                matchId: bc.matchId,
                userId: bc.userId,
                team: droppedTA.team,
              },
              update: { team: droppedTA.team },
            }),
          ]);
          // Resolve label here so step 3 can reference it cleanly.
          const matchForLabels = await db.match.findUnique({
            where: { id: bc.matchId },
            include: { activity: { include: { sport: true } } },
          });
          if (matchForLabels) {
            const teamLabels = matchForLabels.activity.sport.teamLabels as [
              string,
              string,
            ];
            teamSwap = {
              teamLabel:
                droppedTA.team === "RED" ? teamLabels[0] : teamLabels[1],
            };
          }
        }
      } catch (err) {
        // Don't let a swap-side failure stop the announcement.
        console.error("[reaction] team-swap on confirm failed:", err);
      }
    }

    // Step 3 (always): announce the confirmation in the group. Two
    // wordings depending on whether a team-swap landed:
    //   - Teams generated → "X takes Y's place on Red"
    //   - Pre-teams      → "X confirmed for tonight — squad is N/M ✅"
    // Previously this was gated on the team-swap branch, so
    // confirmations BEFORE teams-generation went silent and the group
    // had no idea the slot was filled. Kemal called this out as a
    // gap on 2026-05-05.
    try {
      const matchWithCtx = await db.match.findUnique({
        where: { id: bc.matchId },
        include: {
          activity: { include: { sport: true, org: true } },
          attendances: { where: { status: "CONFIRMED" } },
        },
      });
      const [benchUser, droppedUser] = await Promise.all([
        db.user.findUnique({
          where: { id: bc.userId },
          select: { name: true },
        }),
        bc.replacingUserId
          ? db.user.findUnique({
              where: { id: bc.replacingUserId },
              select: { name: true },
            })
          : null,
      ]);
      if (matchWithCtx && benchUser?.name) {
        const confirmedCount = matchWithCtx.attendances.length;
        const maxPlayers = matchWithCtx.maxPlayers;
        let text: string;
        if (teamSwap && droppedUser?.name) {
          text =
            `🎟 *Slot filled* — *${benchUser.name}* takes *${droppedUser.name}*'s place on *${teamSwap.teamLabel}* 🙌\n\n` +
            `_If anyone wants to rebalance with the new line-up, just say "regenerate teams"._`;
        } else if (droppedUser?.name) {
          text =
            `✅ *${benchUser.name}* confirmed for tonight, replacing *${droppedUser.name}* — squad is *${confirmedCount}/${maxPlayers}* 🙌`;
        } else {
          text =
            `✅ *${benchUser.name}* confirmed from the bench — squad is *${confirmedCount}/${maxPlayers}* 🙌`;
        }
        await db.botJob.create({
          data: {
            orgId: matchWithCtx.activity.org.id,
            kind: "group",
            text,
          },
        });
      }
    } catch (err) {
      console.error("[reaction] confirm announcement failed:", err);
    }

    return NextResponse.json({ ok: true, outcome: "confirmed" });
  }

  // 👎 — they can't play. Mark dropped, chain to next bencher with
  // the SAME replacingUserId so the next prompt offers the same slot.
  await db.$transaction([
    db.pendingBenchConfirmation.update({
      where: { id: bc.id },
      data: { resolvedAt: new Date(), outcome: "declined" },
    }),
    db.attendance.update({
      where: { matchId_userId: { matchId: bc.matchId, userId: bc.userId } },
      data: { status: "DROPPED" },
    }),
  ]);
  await requestBenchConfirmationOnDrop(bc.matchId, bc.replacingUserId);
  return NextResponse.json({ ok: true, outcome: "declined" });
}
