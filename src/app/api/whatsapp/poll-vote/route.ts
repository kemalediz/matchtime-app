/**
 * Bot hits this endpoint when someone casts a vote in a WhatsApp poll
 * that the bot posted.
 *
 * For MoM polls we match the picked option (a player name) against the
 * confirmed-attendance list for that match, then upsert a MoMVote for the
 * (matchId, voterId) pair. The MoMVote table already has a unique
 * constraint on (matchId, voterId), so a voter who votes in both the
 * WhatsApp poll AND via the app magic link will have a single deduped
 * entry — the most recent vote wins.
 *
 * For other polls (payment) we just ACK without acting — vote tracking
 * for payments isn't wired up yet.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { normalisePhone } from "@/lib/phone";

export async function POST(request: Request) {
  const apiKey = request.headers.get("x-api-key");
  if (apiKey !== process.env.WHATSAPP_API_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { waMessageId, voterPhone, voterName, optionName } = body as {
    waMessageId: string;
    voterPhone: string;
    voterName?: string; // optional — bot forwards the pushname when @lid hides the phone
    optionName: string | null;
  };

  if (!waMessageId || !voterPhone) {
    return NextResponse.json({ error: "waMessageId and voterPhone required" }, { status: 400 });
  }

  // Which poll did this vote land on?
  const sent = await db.sentNotification.findFirst({
    where: { waMessageId },
  });
  if (!sent) return NextResponse.json({ ok: true, ignored: "unknown-poll" });

  const isMomPoll = sent.kind.includes("mom-poll") || sent.key.includes(":mom-poll");
  const isPaymentPoll = sent.key.endsWith(":payment-poll");
  if (!isMomPoll && !isPaymentPoll) {
    return NextResponse.json({ ok: true, ignored: `unsupported-poll (${sent.kind})` });
  }
  if (!sent.matchId) return NextResponse.json({ ok: true, ignored: "no-matchId" });

  const matchId = sent.matchId;

  // 1. Try phone match (most accurate).
  let voter: { id: string; name: string | null } | null = null;
  const normalised = normalisePhone(voterPhone);
  if (normalised) {
    voter = await db.user.findUnique({
      where: { phoneNumber: normalised },
      select: { id: true, name: true },
    });
  }

  // 2. Fallback: when WhatsApp hides the voter's phone via @lid privacy,
  //    the bot can still forward their pushname. Fuzzy-match against
  //    the match's org roster — same logic as the analyze route so
  //    "Kara" resolves to "Karahan", "ba" to "Baki", etc.
  if (!voter && voterName && voterName.trim().length >= 2) {
    // Find the match's org via the SentNotification → Match chain.
    const match = await db.match.findUnique({
      where: { id: matchId },
      include: { activity: { select: { orgId: true } } },
    });
    if (match) {
      const orgId = match.activity.orgId;
      const candidates = await db.membership.findMany({
        where: { orgId, leftAt: null },
        include: { user: { select: { id: true, name: true } } },
      });
      const norm = (s: string) =>
        s.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      const pushFirst = norm(voterName).split(/\s+/).filter(Boolean)[0] ?? "";
      const exact = candidates.filter(
        (c) => c.user.name && norm(c.user.name) === norm(voterName),
      );
      let match2: typeof candidates[number] | null = null;
      if (exact.length === 1) match2 = exact[0];
      else {
        const byFirst = candidates.filter((c) => {
          if (!c.user.name) return false;
          const dbFirst = norm(c.user.name).split(/\s+/).filter(Boolean)[0] ?? "";
          return (
            dbFirst === pushFirst ||
            (dbFirst.length >= 3 && pushFirst.length >= 2 && dbFirst.startsWith(pushFirst)) ||
            (pushFirst.length >= 3 && dbFirst.length >= 2 && pushFirst.startsWith(dbFirst))
          );
        });
        if (byFirst.length === 1) match2 = byFirst[0];
      }
      if (match2) {
        voter = { id: match2.user.id, name: match2.user.name };
      }
    }
  }

  if (!voter) return NextResponse.json({ ok: true, ignored: "unknown-voter" });

  // Payment poll — any non-null option (either team) means "paid".
  // Un-vote clears the flag.
  if (isPaymentPoll) {
    // Org-level kill switch: when payment tracking is off, the poll
    // is still posted by the bot at match-end so people can see it
    // and Elvin (or whoever collects) can eyeball who ticked. We
    // just don't write paidAt server-side. ACK with a clear marker
    // so the bot logs aren't noisy.
    const orgRow = await db.match.findUnique({
      where: { id: matchId },
      select: { activity: { select: { org: { select: { paymentTrackingEnabled: true } } } } },
    });
    if (!orgRow?.activity.org.paymentTrackingEnabled) {
      return NextResponse.json({ ok: true, ignored: "payment-tracking-disabled" });
    }

    const existing = await db.attendance.findUnique({
      where: { matchId_userId: { matchId, userId: voter.id } },
    });
    if (!existing) return NextResponse.json({ ok: true, ignored: "not-attending" });
    await db.attendance.update({
      where: { id: existing.id },
      data: { paidAt: optionName ? new Date() : null },
    });
    return NextResponse.json({ ok: true, action: optionName ? "paid" : "unpaid" });
  }

  // No option means the user un-voted — delete the MoMVote.
  if (!optionName) {
    await db.moMVote.deleteMany({
      where: { matchId, voterId: voter.id },
    });
    return NextResponse.json({ ok: true, action: "cleared" });
  }

  // Resolve option name → player via confirmed attendances for this match.
  const confirmed = await db.attendance.findMany({
    where: { matchId, status: "CONFIRMED" },
    include: { user: { select: { id: true, name: true } } },
  });
  const normaliseName = (s: string) =>
    s.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const target = confirmed.find(
    (a) => normaliseName(a.user.name ?? "") === normaliseName(optionName),
  );
  if (!target) {
    return NextResponse.json({ ok: true, ignored: "option-no-match" });
  }
  if (target.userId === voter.id) {
    // Can't vote for yourself via the poll either.
    return NextResponse.json({ ok: true, ignored: "self-vote" });
  }

  await db.moMVote.upsert({
    where: { matchId_voterId: { matchId, voterId: voter.id } },
    create: { matchId, voterId: voter.id, playerId: target.userId },
    update: { playerId: target.userId },
  });

  return NextResponse.json({ ok: true, action: "recorded", playerId: target.userId });
}
