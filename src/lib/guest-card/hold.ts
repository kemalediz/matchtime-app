/**
 * A CONTACT CARD, HELD FOR ITS REQUEST (2026-11-17). Thin I/O.
 *
 * WhatsApp sends a shared contact as a message of its own, with no words,
 * and the organiser's "add him for tonight" arrives as the next message
 * (in HQ the card cannot carry the tag, so it never can be read on its
 * own). An organiser's card is held here for `GUEST_CARD_WINDOW_MS`, per
 * door and club, and the request that follows from the SAME sender takes
 * it. A held card is kept until an add uses it (then it is deleted), or
 * until its window ends (review of #621: "who is this?" then "add Sam Jones").
 *
 * Stored as a `SentNotification` row (kind "guest-card-held"), which every
 * door already writes: no new table. The text is the card's name and
 * number as JSON, kept in the database only, never logged.
 */
import { db } from "../db";
import { GUEST_CARD_WINDOW_MS } from "./rules";
import type { ContactCard } from "./vcard";

export const HELD_KIND = "guest-card-held";
/** Held rows are pruned after a day (they are useless after the window). */
const PRUNE_AFTER_MS = 24 * 3600_000;

const prefix = (scope: string, senderUserId: string) => `guest-card:held:${scope}:${senderUserId}:`;

export interface HeldCards {
  keys: string[];
  cards: ContactCard[];
}

/** Hold an organiser's card. Idempotent per message. Never throws. */
export async function holdCards(a: { scope: string; senderUserId: string; waMessageId: string; cards: ContactCard[]; now: Date }): Promise<void> {
  try {
    await db.sentNotification.deleteMany({ where: { kind: HELD_KIND, createdAt: { lt: new Date(a.now.getTime() - PRUNE_AFTER_MS) } } });
    await db.sentNotification.createMany({
      data: [{ key: `${prefix(a.scope, a.senderUserId)}${a.waMessageId}`, kind: HELD_KIND, targetUser: a.senderUserId, text: JSON.stringify(a.cards), createdAt: a.now }],
      skipDuplicates: true,
    });
  } catch (err) {
    console.error(`[guest-card] card ${a.waMessageId} not held:`, err instanceof Error ? err.message : "failed");
  }
}

/** The sender's cards held in this door in the window, oldest first. */
export async function heldCards(a: { scope: string; senderUserId: string; now: Date }): Promise<HeldCards> {
  const all = await db.sentNotification.findMany({
    where: { kind: HELD_KIND, key: { startsWith: prefix(a.scope, a.senderUserId) } },
    orderBy: { createdAt: "asc" },
    select: { key: true, text: true, createdAt: true },
  });
  // Pruned on read as well as on every hold (review of #621): his cards past
  // their window are deleted the moment they are seen, so a card never
  // outlives its window by more than the next look at it.
  const since = a.now.getTime() - GUEST_CARD_WINDOW_MS;
  const stale = all.filter((r) => r.createdAt.getTime() < since).map((r) => r.key);
  if (stale.length > 0) await db.sentNotification.deleteMany({ where: { key: { in: stale }, kind: HELD_KIND } }).catch(() => {});
  const rows = all.filter((r) => r.createdAt.getTime() >= since);
  const out: HeldCards = { keys: [], cards: [] };
  for (const r of rows) {
    try {
      const cards = JSON.parse(r.text ?? "[]") as ContactCard[];
      out.keys.push(r.key);
      out.cards.push(...cards.filter((c) => c && typeof c === "object"));
    } catch {
      /* a garbled row holds nothing */
    }
  }
  return out;
}

/** The cards were used: deleted, so no later request takes them again. */
export async function spendHeldCards(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await db.sentNotification.deleteMany({ where: { key: { in: keys }, kind: HELD_KIND } }).catch(() => {});
}
