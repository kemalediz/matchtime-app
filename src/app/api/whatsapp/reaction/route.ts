/**
 * Reactions on messages the bot sent.
 *
 * Two things can be reacted to:
 *
 *   1. The GROUP bench-slot-offer post (2026-05-19) — a 👍 from any
 *      current bench player claims the slot, first one wins; 👎 is a
 *      no-op because nobody is ever removed for passing.
 *   2. The 1-1 RECRUIT INVITE DM (2026-08-31) — a 👍 registers the player
 *      IN and a 👎 registers them OUT. Unlike the bench offer, 👎 is NOT
 *      a no-op: the owner asked for saying no to be as easy as saying
 *      yes. The invite does not currently ADVERTISE this (inbound
 *      reaction forwarding is broken on the Pi, so the copy would be
 *      asking for something that does nothing — see
 *      RECRUIT_DM_MENTION_REACTIONS in src/lib/recruit.ts), but the
 *      handling stays live so an unprompted 👍 still counts. See
 *      src/lib/recruit-reaction.ts for how a reaction finds its player
 *      and its match.
 *
 * The bench branch runs first and is unchanged. Its reactor resolution is
 * scoped to the bench of the offer's match (phone first, then @lid
 * pushname matched UNIQUELY against that small bench set) because a
 * GROUP post can be reacted to by anybody and we must not promote a
 * non-bencher. The DM branch has no such problem: see below.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { normalisePhone } from "@/lib/phone";
import { resolveBenchConfirmation } from "@/lib/bench-confirmation";
import { classifyReactionAttendance, resolveRecruitDmReaction } from "@/lib/recruit-reaction";
import { applyOutOfBandSelfAttendance } from "@/lib/out-of-band-self-attendance";
import { formatLondon } from "@/lib/london-time";

const norm = (s: string) =>
  s.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

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
    fromAuthorName?: string | null;
  };
  if (!waMessageId || !emoji) {
    return NextResponse.json({ error: "waMessageId, emoji required" }, { status: 400 });
  }

  // The offer post the reaction is on (set on /ack via the offer- key).
  const offer = await db.benchSlotOffer.findFirst({
    where: { waMessageId, resolvedAt: null },
    include: {
      match: {
        include: {
          activity: { select: { orgId: true } },
          attendances: {
            where: { status: "BENCH" },
            include: { user: { select: { id: true, name: true, phoneNumber: true } } },
          },
        },
      },
    },
  });
  if (!offer) {
    // Not a bench offer. Was it the recruit invite DM?
    const recruit = await handleRecruitDmReaction({
      waMessageId,
      emoji,
      fromPhone,
    });
    if (recruit) return NextResponse.json(recruit);
    return NextResponse.json({ ok: true, ignored: "no-open-offer" });
  }

  const isYes =
    emoji === "👍" || emoji === "👍🏻" || emoji === "👍🏼" || emoji === "👍🏽" ||
    emoji === "👍🏾" || emoji === "👍🏿" || emoji === "✅" || emoji === "🙋" ||
    emoji === "🙋‍♂️" || emoji === "🙋‍♀️";
  const isNo =
    emoji === "👎" || emoji === "👎🏻" || emoji === "👎🏼" || emoji === "👎🏽" ||
    emoji === "👎🏾" || emoji === "👎🏿";
  if (!isYes && !isNo) {
    return NextResponse.json({ ok: true, ignored: "not-yes-no" });
  }
  if (isNo) {
    // Passing is a no-op — they stay on the bench. Nothing to do.
    return NextResponse.json({ ok: true, outcome: "declined" });
  }

  // Resolve the reactor to one of THIS match's bench players.
  const bench = offer.match.attendances;
  let claimantId: string | null = null;

  const normalised = fromPhone ? normalisePhone(fromPhone) : null;
  if (normalised) {
    const m = bench.find(
      (a) => a.user.phoneNumber && normalisePhone(a.user.phoneNumber) === normalised,
    );
    if (m) claimantId = m.user.id;
  }
  if (!claimantId && fromAuthorName && fromAuthorName.trim().length >= 2) {
    const key = norm(fromAuthorName);
    const orgId = offer.match.activity.orgId;
    // Exact name among the bench.
    const exact = bench.filter((a) => a.user.name && norm(a.user.name) === key);
    if (exact.length === 1) claimantId = exact[0].user.id;
    // Admin alias → must point at a bench member.
    if (!claimantId) {
      const alias = await db.userAlias.findUnique({
        where: { orgId_alias: { orgId, alias: key } },
        select: { userId: true },
      });
      if (alias && bench.some((a) => a.user.id === alias.userId)) {
        claimantId = alias.userId;
      }
    }
    // Unique first-name fuzzy within the bench set only.
    if (!claimantId) {
      const pf = key.split(/\s+/).filter(Boolean)[0] ?? "";
      const fz = bench.filter((a) => {
        if (!a.user.name) return false;
        const df = norm(a.user.name).split(/\s+/).filter(Boolean)[0] ?? "";
        return (
          df === pf ||
          (df.length >= 3 && pf.length >= 2 && df.startsWith(pf)) ||
          (pf.length >= 3 && df.length >= 2 && pf.startsWith(df))
        );
      });
      if (fz.length === 1) claimantId = fz[0].user.id;
    }
  }

  if (!claimantId) {
    return NextResponse.json({ ok: true, ignored: "reactor-not-on-bench" });
  }

  const res = await resolveBenchConfirmation({
    matchId: offer.matchId,
    userId: claimantId,
    decision: true,
  });
  return NextResponse.json({ ok: true, outcome: res.kind });
}

/**
 * A 👍 or 👎 on the recruit invite DM.
 *
 * Returns null when this reaction is not on an invite we sent, so the
 * caller falls through to its existing "ignored" response.
 *
 * REACTOR IDENTITY. In a 1-1 chat only two parties exist: MatchTime and
 * the player we DMed. So the DM itself identifies the player, and an
 * @lid reactor with no readable phone is handled for free (the failure
 * mode that lost Erdal's bench 👎 on 2026-05-18 cannot occur here). The
 * phone check below is therefore a SEATBELT, not the resolution: it only
 * rejects a reactor we can positively identify as somebody else, which in
 * practice means the bot reacting to its own message.
 */
async function handleRecruitDmReaction(input: {
  waMessageId: string;
  emoji: string;
  fromPhone: string;
}): Promise<Record<string, unknown> | null> {
  const target = await resolveRecruitDmReaction(input.waMessageId);
  if (!target) return null;

  const decision = classifyReactionAttendance(input.emoji);
  if (!decision) return { ok: true, ignored: "not-yes-no" };

  if (input.fromPhone && target.phone) {
    const reactor = normalisePhone(input.fromPhone);
    const recipient = normalisePhone(target.phone);
    if (reactor && recipient && reactor !== recipient) {
      return { ok: true, ignored: "reactor-not-the-recipient" };
    }
  }

  const match = await db.match.findUnique({
    where: { id: target.matchId },
    select: {
      status: true,
      date: true,
      activity: { select: { name: true, orgId: true } },
    },
  });
  // A reaction on a stale invite (match played, or called off) changes
  // nothing. Silently ignored rather than registering someone for a game
  // that no longer exists.
  if (!match) return { ok: true, ignored: "match-missing" };
  if (!["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"].includes(match.status)) {
    return { ok: true, ignored: "match-not-open" };
  }

  const res = await applyOutOfBandSelfAttendance({
    userId: target.userId,
    matchId: target.matchId,
    orgId: match.activity.orgId,
    decision,
    matchName: match.activity.name,
    matchWhen: formatLondon(match.date, "EEE d MMM, HH:mm"),
    source: "reaction",
    replyPhone: target.phone,
  });

  return {
    ok: true,
    handled: "recruit-dm-reaction",
    decision,
    status: res.status,
    announced: res.announced,
    matchId: target.matchId,
  };
}
