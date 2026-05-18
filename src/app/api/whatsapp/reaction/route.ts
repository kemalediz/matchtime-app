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
  const { waMessageId, emoji, fromPhone, fromAuthorName } = body as {
    waMessageId: string;
    emoji: string;
    fromPhone: string;
    /** Reactor's WhatsApp pushname. Forwarded by the bot for @lid
     *  privacy reactors (no phone in the senderId). Optional — older
     *  bot builds don't send it; we fall back to phone-only then. */
    fromAuthorName?: string | null;
  };
  // fromPhone may be empty for @lid reactors — only waMessageId+emoji
  // are strictly required now (the @lid fallback uses fromAuthorName).
  if (!waMessageId || !emoji) {
    return NextResponse.json({ error: "waMessageId, emoji required" }, { status: 400 });
  }

  const bc = await db.pendingBenchConfirmation.findFirst({
    where: { waMessageId, resolvedAt: null },
    include: { match: true },
  });
  if (!bc) return NextResponse.json({ ok: true, ignored: "no-pending-confirmation" });

  // ── Reactor identity check ───────────────────────────────────────
  //   We don't need general sender resolution here — we already know
  //   exactly who we're waiting on (bc.userId). The only question is:
  //   "did THAT person react?". Two paths:
  //     1. Phone (most reliable, @c.us reactors).
  //     2. @lid privacy reactors arrive with no usable phone — verify
  //        the forwarded pushname maps to bc.userId via exact name /
  //        UserAlias / unique first-name fuzzy, all SCOPED to the org
  //        and ultimately to bc.userId. Tightly bounded: a wrong guess
  //        can only ever accept/reject the one expected user, never
  //        promote a random person.
  //   This mirrors the @lid fallback the analyze + dm-reply routes
  //   already use; the reaction route was the last phone-only path
  //   (Kemal flagged 2026-05-18: Erdal's 👎 silently lost because he
  //   reacts via @lid privacy).
  let isExpectedUser = false;
  const normalised = fromPhone ? normalisePhone(fromPhone) : null;
  if (normalised) {
    const byPhone = await db.user.findUnique({ where: { phoneNumber: normalised } });
    if (byPhone && byPhone.id === bc.userId) isExpectedUser = true;
  }
  if (!isExpectedUser && fromAuthorName && fromAuthorName.trim().length >= 2) {
    isExpectedUser = await pushnameMatchesUser({
      orgId: bc.match.activityId
        ? (await db.activity.findUnique({
            where: { id: bc.match.activityId },
            select: { orgId: true },
          }))?.orgId ?? null
        : null,
      pushname: fromAuthorName.trim(),
      expectedUserId: bc.userId,
    });
  }
  if (!isExpectedUser) {
    // Either a different user reacted, or we genuinely couldn't tie
    // the @lid reactor to the expected bench player. Same conservative
    // behaviour as before: ignore. (The in-group 👍/👎 message path
    // via /analyze is the backstop — it has the full resolver chain.)
    return NextResponse.json({ ok: true, ignored: "wrong-or-unresolved-user" });
  }
  // From here on the reactor IS the expected bench player (bc.userId).

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

/**
 * Verify a WhatsApp pushname belongs to `expectedUserId` within `orgId`.
 * Deliberately NARROW — this is not a general resolver, it only answers
 * "is this @lid reactor the specific bench player we're waiting on?".
 * A false positive can at worst accept/reject the ONE expected user's
 * own prompt; it can never promote a third party. Order mirrors the
 * analyze-route resolver, scoped to the single expected user:
 *   1. exact case-insensitive name equality
 *   2. UserAlias (admin-curated nickname / short pushname → user)
 *   3. unique first-name fuzzy among the expected user's org memberships
 */
async function pushnameMatchesUser(args: {
  orgId: string | null;
  pushname: string;
  expectedUserId: string;
}): Promise<boolean> {
  const { orgId, pushname, expectedUserId } = args;
  if (!orgId) return false;
  const norm = (s: string) =>
    s.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const key = norm(pushname);
  if (key.length < 2) return false;

  const expected = await db.user.findUnique({
    where: { id: expectedUserId },
    select: { id: true, name: true },
  });
  if (!expected) return false;

  // 1. Exact name equality.
  if (expected.name && norm(expected.name) === key) return true;

  // 2. Alias — must point at the expected user specifically.
  const alias = await db.userAlias.findUnique({
    where: { orgId_alias: { orgId, alias: key } },
    select: { userId: true },
  });
  if (alias && alias.userId === expectedUserId) return true;

  // 3. First-name fuzzy, but ONLY accept if the expected user is the
  //    UNIQUE org member matching this pushname (so "ba" → Baki is
  //    accepted only when Baki is the sole "ba*"; if Başar also
  //    matches, we refuse — exactly the ambiguity guard from analyze).
  const memberships = await db.membership.findMany({
    where: { orgId },
    include: { user: { select: { id: true, name: true } } },
  });
  const pushFirst = key.split(/\s+/).filter(Boolean)[0] ?? "";
  const matches = memberships.filter((m) => {
    if (!m.user.name) return false;
    const dbFirst = norm(m.user.name).split(/\s+/).filter(Boolean)[0] ?? "";
    return (
      dbFirst === pushFirst ||
      (dbFirst.length >= 3 && pushFirst.length >= 2 && dbFirst.startsWith(pushFirst)) ||
      (pushFirst.length >= 3 && dbFirst.length >= 2 && pushFirst.startsWith(dbFirst))
    );
  });
  return matches.length === 1 && matches[0].user.id === expectedUserId;
}
