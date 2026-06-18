/**
 * Bot reports back after executing a due instruction. Writes a
 * SentNotification row so the same key won't fire again. For bench prompts
 * we also patch the waMessageId onto the PendingBenchConfirmation so the
 * reaction handler can look it up.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function POST(request: Request) {
  const apiKey = request.headers.get("x-api-key");
  if (apiKey !== process.env.WHATSAPP_API_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { key, kind, matchId, targetUser, waMessageId, benchUserId } = body as {
    key: string;
    kind: string;
    matchId?: string;
    targetUser?: string;
    waMessageId?: string;
    benchUserId?: string; // for bench-prompt kind
  };

  if (!key || !kind) {
    return NextResponse.json({ error: "key and kind required" }, { status: 400 });
  }

  await db.sentNotification.upsert({
    where: { key },
    create: { key, kind, matchId, targetUser, waMessageId },
    update: { waMessageId: waMessageId ?? undefined },
  });

  // Bench redesign 2026-05-19: the group offer post is keyed
  // `offer-<benchSlotOfferId>`. Stamp its waMessageId onto the offer
  // so a 👍 reaction maps back to it (reaction route resolves by
  // BenchSlotOffer.waMessageId). The per-bencher DM key
  // `offer-<id>:dm:<userId>` is NOT an offer-post — skip those.
  if (key.startsWith("offer-") && !key.includes(":dm:") && waMessageId) {
    const offerId = key.slice("offer-".length);
    await db.benchSlotOffer.updateMany({
      where: { id: offerId, resolvedAt: null },
      data: { waMessageId },
    });
  }

  // BotJob keys look like `botjob-<id>`; close them out so they don't
  // re-enqueue on the next poll.
  if (key.startsWith("botjob-")) {
    const botJobId = key.slice("botjob-".length);
    await db.botJob.update({
      where: { id: botJobId },
      data: { sentAt: new Date() },
    }).catch(() => {}); // tolerate already-sent or deleted rows
  }

  // RetroReaction keys look like `retro-react-<id>`; same idempotency
  // model — once acked, don't re-emit.
  if (key.startsWith("retro-react-")) {
    const retroId = key.slice("retro-react-".length);
    await db.retroReaction.update({
      where: { id: retroId },
      data: { sentAt: new Date() },
    }).catch(() => {});
  }

  // Tentative-availability follow-up keys look like
  // `<matchId>:tentative-followup:<userId>` — stamp notifiedAt on the row
  // so the scheduler's dueRows query stops returning it (the question has
  // now been asked; the player's IN/OUT reply resolves it).
  if (key.includes(":tentative-followup:")) {
    const [mId, , uId] = key.split(":");
    if (mId && uId) {
      await db.tentativeAvailability
        .updateMany({
          where: { matchId: mId, userId: uId, notifiedAt: null },
          data: { notifiedAt: new Date() },
        })
        .catch(() => {});
    }
  }

  return NextResponse.json({ ok: true });
}
