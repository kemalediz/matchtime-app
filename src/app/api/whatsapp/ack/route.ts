/**
 * Bot reports back after executing a due instruction.
 *
 * ── Post-2026-07-19: ACK no longer creates the dedupe row ─────────────
 * The SentNotification row is now created at DISPATCH time by
 * /api/whatsapp/due-posts (claim-on-dispatch), using the @unique
 * constraint on `key` so only one poller can ever be handed a given
 * instruction. ACK is therefore an idempotent UPDATE: it stamps the
 * waMessageId and runs the same per-key-class side effects it always did
 * (botjob-… → sentAt, offer-… → BenchSlotOffer.waMessageId,
 * retro-react-… → sentAt, …:tentative-followup:… → notifiedAt).
 *
 * We still tolerate an ACK for a key with no claim row (upsert rather
 * than a bare update) so an in-flight instruction handed out by an older
 * build, or a replayed ACK, can't 500. That path is defensive only —
 * it is no longer how the row normally comes into existence.
 *
 * ── `release: true` ───────────────────────────────────────────────────
 * The bot's DM rate limiter deliberately HOLDS a DM back and relies on
 * the server re-emitting it on the next poll. Under claim-on-dispatch
 * that held DM is already claimed, so it would be silently lost. The bot
 * therefore releases the claim (deleting the row, but only while it has
 * no waMessageId — i.e. was never actually sent) and the instruction is
 * re-emitted normally next tick.
 *
 * ── `platform-<id>` keys (self-join slice 3) ──────────────────────────
 * A Pi built before slice 3 does not poll /api/whatsapp/platform-jobs, so
 * due-posts bridges platform DMs (sign-up codes) to it under this key
 * class. Their acks move the PlatformJob row and write NO SentNotification:
 *   ack with a waMessageId  sent
 *   ack without one         unconfirmed. That build acks a DM whose send
 *                           FAILED exactly like this, so "sent" would lie.
 *   release                 back to queued (the Pi's DM pacing)
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { planAckSideEffects } from "@/lib/dispatch-claim";
import { parsePlatformJobKey, recordPlatformJobOutcome } from "@/lib/platform-jobs";
import { stagePaygFeeOnAsk } from "@/lib/monthly-week";

export async function POST(request: Request) {
  const apiKey = request.headers.get("x-api-key");
  if (apiKey !== process.env.WHATSAPP_API_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { key, kind, matchId, targetUser, waMessageId, release } = body as {
    key: string;
    kind?: string;
    matchId?: string;
    targetUser?: string;
    waMessageId?: string;
    benchUserId?: string; // for bench-prompt kind (unused; kept for compat)
    release?: boolean;
  };

  if (!key) {
    return NextResponse.json({ error: "key required" }, { status: 400 });
  }

  // ── Platform jobs bridged through due-posts to an older Pi ──────────
  const platformJobId = parsePlatformJobKey(key);
  if (platformJobId) {
    if (release) {
      const { updated } = await recordPlatformJobOutcome(platformJobId, { outcome: "release" });
      return NextResponse.json({ ok: true, released: updated });
    }
    const { updated } = await recordPlatformJobOutcome(
      platformJobId,
      waMessageId
        ? { outcome: "sent", waMessageId }
        : {
            outcome: "unconfirmed",
            reason:
              "acked without a message id by a bot build older than self-join slice 3, which acks a " +
              "failed DM the same way: delivery unconfirmed",
          },
    );
    return NextResponse.json({ ok: true, updated });
  }

  // ── Release path: the bot claimed this but chose not to send it ─────
  if (release) {
    const { count } = await db.sentNotification.deleteMany({
      where: { key, waMessageId: null },
    });
    return NextResponse.json({ ok: true, released: count > 0 });
  }

  if (!kind) {
    return NextResponse.json({ error: "key and kind required" }, { status: 400 });
  }

  // Idempotent: stamps waMessageId on the claim row. The create branch is
  // a defensive fallback for keys that were never claimed here.
  await db.sentNotification.upsert({
    where: { key },
    create: { key, kind, matchId, targetUser, waMessageId },
    update: { waMessageId: waMessageId ?? undefined },
  });

  // Per-key-class side effects — identical set to pre-claim behaviour,
  // just derived by a unit-tested pure mapper. Each is itself idempotent
  // so a replayed ACK is harmless.
  // MONTHLY SQUAD (slice 5): the collector has now been SENT the fee
  // question for this match, so (for a monthly club with a PAYG price, and
  // nobody else) that price becomes the amount awaiting their yes. Not
  // before: see `stagePaygFeeOnAsk`. A released claim never gets here.
  if (key.endsWith(":fee-ask")) {
    await stagePaygFeeOnAsk(key.slice(0, -":fee-ask".length)).catch((err) =>
      console.error(`[ack] staging the PAYG fee for ${key} failed:`, err),
    );
  }

  for (const effect of planAckSideEffects(key)) {
    switch (effect.type) {
      case "offer-wa-message-id":
        // Bench redesign 2026-05-19: the group offer post is keyed
        // `offer-<benchSlotOfferId>`. Stamp its waMessageId onto the
        // offer so a 👍 reaction maps back to it (the reaction route
        // resolves by BenchSlotOffer.waMessageId). Only meaningful when
        // the bot actually reported a message id.
        if (waMessageId) {
          await db.benchSlotOffer.updateMany({
            where: { id: effect.offerId, resolvedAt: null },
            data: { waMessageId },
          });
        }
        break;

      case "botjob-sent":
        // BotJob keys look like `botjob-<id>`; close them out so they
        // don't re-enqueue on the next poll.
        await db.botJob
          .update({ where: { id: effect.botJobId }, data: { sentAt: new Date() } })
          .catch(() => {}); // tolerate already-sent or deleted rows
        break;

      case "retro-reaction-sent":
        // RetroReaction keys look like `retro-react-<id>`; same
        // idempotency model — once acked, don't re-emit.
        await db.retroReaction
          .update({ where: { id: effect.retroReactionId }, data: { sentAt: new Date() } })
          .catch(() => {});
        break;

      case "tentative-followup-notified":
        // `<matchId>:tentative-followup:<userId>` — stamp notifiedAt so
        // the scheduler's dueRows query stops returning it (the question
        // has now been asked; the player's IN/OUT reply resolves it).
        await db.tentativeAvailability
          .updateMany({
            where: { matchId: effect.matchId, userId: effect.userId, notifiedAt: null },
            data: { notifiedAt: new Date() },
          })
          .catch(() => {});
        break;
    }
  }

  return NextResponse.json({ ok: true });
}
