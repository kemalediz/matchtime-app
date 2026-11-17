/**
 * BRINGING A GUEST: ONE STEP, THREE DOORS, ONE PATH (Kemal, 2026-11-17).
 *
 * "Bringing a guest must be simple." An organiser (an owner or admin of
 * the club) shares the guest's WhatsApp contact card, or writes his name
 * and number, with words like "add him for tonight", in the players'
 * group, the organisers' group (HQ) or a DM to MatchTime. Each door calls
 * the same function here (`readAndAdd`), with the facts only that door
 * has; nothing is decided differently per door:
 *
 *   1. A CARD from an organiser is held (`hold.ts`) and nothing is said:
 *      it is the person his next words are about. A card from anyone else
 *      is not touched here: the attendance engine refuses it as before
 *      (the 2026-06-11 "Salman Shelly Ftbl" incident, which this keeps).
 *   2. His next message (or one replying to the card, or one with a phone
 *      number in it) is read by the guest reader (`reader.ts`, the model):
 *      does it ask to put the person into a game, which game, and did he
 *      write a name or a number. In HQ only a real tag is read.
 *   3. Yes, sure enough: the guest is added (`add.ts`) and the organiser
 *      gets ONE reply where he asked. No: nothing happens here and the
 *      message carries on through the door's own pipeline untouched.
 *
 * Code reads the card's container (`vcard.ts`) and checks the number the
 * model returned is the one written (`phoneWrittenIn`). Nothing here reads
 * a person's words.
 */
import { db } from "../db";
import { isAiBudgetExceeded, withOrgAiBudget } from "../ai-budget";
import { LIVE_STAGE_WHERE } from "../club-setup-rules";
import { ORDINARY_MEMBER_WHERE } from "../guest-membership";
import { normalisePhone, e164Digits } from "../phone";
import { addGuest } from "./add";
import { loadComingGames } from "./facts";
import { heldCards, holdCards, spendHeldCards } from "./hold";
import { GUEST_ADD_FLOOR, readGuestAdd } from "./reader";
import { cleanCardName, hasPhoneNumberShape, isOrganiserMembership, phoneWrittenIn, pickGame, shouldReadGuestAdd, type GuestCardDoor } from "./rules";
import { CONTACT_CARD_LABEL, isContactCard, readContactCards, type ContactCard } from "./vcard";
import { organiserReply } from "./copy";
import { normaliseLang } from "../i18n/lang";

export type DoorResult =
  /** An organiser's card: held, nothing said. */
  | { kind: "held" }
  /** The request was read and acted on: the one reply. */
  | { kind: "answered"; reply: string; orgId: string; added: number }
  /** Not this feature's: carry on as before. */
  | { kind: "not-mine" };

interface DoorMessage {
  door: GuestCardDoor;
  /** The clubs he organises that this door speaks for. */
  orgIds: string[];
  /** Where his cards are held: one place per door and club. */
  scope: string;
  senderUserId: string;
  senderName: string | null;
  messageId: string;
  text: string;
  /** The text of the message his message replies to, if any. */
  quotedText: string | null;
  tagged: boolean;
  now: Date;
}

/** The parsed number of a typed guest, or null. */
function typedPhone(raw: string | null): string | null {
  if (!raw) return null;
  const direct = normalisePhone(raw);
  if (direct) return direct;
  const d = e164Digits(raw);
  return d ? `+${d}` : null;
}

/** The one path every door takes. */
export async function readAndAdd(m: DoorMessage): Promise<DoorResult> {
  if (isContactCard(m.text)) {
    await holdCards({ scope: m.scope, senderUserId: m.senderUserId, waMessageId: m.messageId, cards: readContactCards(m.text), now: m.now });
    return { kind: "held" };
  }
  const held = await heldCards({ scope: m.scope, senderUserId: m.senderUserId, now: m.now });
  const quoted = isContactCard(m.quotedText) ? readContactCards(m.quotedText) : [];
  // A reply to a card is about THAT card; otherwise every card he just shared.
  const cards: ContactCard[] = quoted.length > 0 ? quoted : held.cards;
  const numberInText = hasPhoneNumberShape(m.text);
  if (!shouldReadGuestAdd({ organiser: true, cardsHeld: cards.length, quotedCard: quoted.length > 0, numberInText, tagged: m.tagged, door: m.door })) {
    return { kind: "not-mine" };
  }
  const games = await loadComingGames(m.orgIds, m.now);
  const budgetOrgId = games[0]?.orgId ?? m.orgIds[0];
  let reading;
  try {
    reading = await withOrgAiBudget(budgetOrgId, () =>
      readGuestAdd(m.text, {
        now: m.now,
        games: games.map((g) => ({ club: g.club, kickoff: g.kickoff })),
        cards: cards.map((c) => ({ name: cleanCardName(c.name) })),
        quotedCard: quoted.length > 0,
        senderName: m.senderName,
      }),
    );
  } catch (err) {
    if (isAiBudgetExceeded(err)) {
      console.log(`[guest-card] ${m.messageId}: the club is at its daily AI cap; not read`);
      return { kind: "not-mine" };
    }
    throw err;
  }
  if (!reading.add || reading.confidence < GUEST_ADD_FLOOR) {
    console.log(`[guest-card] ${m.messageId}: not an add (${reading.add ? `confidence ${reading.confidence}` : "no"})`);
    return { kind: "not-mine" };
  }

  // WHO: the cards, or the number he wrote (verified against his words).
  let people: Array<{ phone: string | null; cardName: string | null; writtenName: string | null }>;
  if (cards.length > 0) {
    people = cards.map((c) => ({ phone: c.phone, cardName: c.name, writtenName: cards.length === 1 ? reading.name : null }));
  } else {
    const phone = reading.phone && phoneWrittenIn(reading.phone, m.text) ? typedPhone(reading.phone) : null;
    // No number he wrote: not this feature's (a named add carries on to the
    // attendance engine, as it always has).
    if (!phone) return { kind: "not-mine" };
    people = [{ phone, cardName: null, writtenName: reading.name }];
  }

  const game = pickGame(games, reading.game);
  if (!game) {
    const orgId = m.orgIds[0];
    const lang = normaliseLang((await db.organisation.findUnique({ where: { id: orgId }, select: { language: true } }))?.language);
    return { kind: "answered", reply: organiserReply(lang, { kind: "no-game" }), orgId, added: 0 };
  }
  const replies: string[] = [];
  let added = 0;
  for (const p of people) {
    const out = await addGuest({ orgId: game.orgId, matchId: game.matchId, organiserUserId: m.senderUserId, phone: p.phone, writtenName: p.writtenName, cardName: p.cardName, sourceRef: m.messageId, now: m.now });
    replies.push(out.reply);
    if (out.kind === "in" || out.kind === "bench" || out.kind === "already-in" || out.kind === "already-bench") added++;
  }
  // The cards are used once they were acted on, whatever the outcome: a
  // refusal is said once, and the next card starts afresh.
  if (quoted.length === 0) await spendHeldCards(held.keys);
  return { kind: "answered", reply: replies.join("\n"), orgId: game.orgId, added };
}

// ── The organiser's clubs ──────────────────────────────────────────────

/** Is this user an organiser of this club? */
export async function organisesClub(userId: string | null, orgId: string): Promise<boolean> {
  if (!userId) return false;
  const m = await db.membership.findUnique({
    where: { userId_orgId: { userId, orgId } },
    select: { role: true, leftAt: true, guestMatchId: true, guestFromOrgId: true, guestVia: true },
  });
  return isOrganiserMembership(m);
}

// ── The players' group ─────────────────────────────────────────────────

export interface BatchMessage {
  waMessageId: string;
  body: string;
  quotedBody: string | null;
  senderUserId: string | null;
  senderName: string | null;
  tagged: boolean;
}

export interface BatchConsumed {
  waMessageId: string;
  /** What is stored and shown as this message's text: a card never keeps its number. */
  storedBody: string;
  reply: string | null;
  intent: string;
  reasoning: string;
}

/**
 * A batch of the players' group, in arrival order. An organiser's card is
 * held and leaves the batch; a request the guest reader takes leaves it
 * with its one reply. A card earlier in the same batch counts for a
 * request after it; a request before a card in the same batch is read with
 * that card too. Everything else is left exactly as it came.
 */
export async function handleGuestCardsInBatch(a: { orgId: string; messages: BatchMessage[]; now: Date }): Promise<{ consumed: BatchConsumed[] }> {
  const consumed: BatchConsumed[] = [];
  const organiser = new Map<string, boolean>();
  const isOrg = async (userId: string | null) => {
    if (!userId) return false;
    if (!organiser.has(userId)) organiser.set(userId, await organisesClub(userId, a.orgId));
    return organiser.get(userId)!;
  };
  const scope = `g:${a.orgId}`;
  // A request written just BEFORE its card in one batch: the card is held
  // first, so the request finds it.
  const cardsFirst = [...a.messages].sort((x, y) => Number(isContactCard(y.body)) - Number(isContactCard(x.body)));
  for (const m of cardsFirst) {
    try {
      if (!(await isOrg(m.senderUserId))) continue;
      const r = await readAndAdd({
        door: "players",
        orgIds: [a.orgId],
        scope,
        senderUserId: m.senderUserId!,
        senderName: m.senderName,
        messageId: m.waMessageId,
        text: m.body,
        quotedText: m.quotedBody,
        tagged: m.tagged,
        now: a.now,
      });
      if (r.kind === "held") {
        consumed.push({ waMessageId: m.waMessageId, storedBody: CONTACT_CARD_LABEL, reply: null, intent: "noise", reasoning: "guest-card: an organiser's contact card, held for his request" });
      } else if (r.kind === "answered") {
        consumed.push({ waMessageId: m.waMessageId, storedBody: m.body, reply: r.reply, intent: "admin_command", reasoning: `guest-card: ${r.added} guest(s) added by an organiser` });
      }
    } catch (err) {
      console.error(`[guest-card] ${m.waMessageId}: failed; left to the pipeline:`, err instanceof Error ? err.message : "failed");
    }
  }
  return { consumed };
}

// ── HQ ─────────────────────────────────────────────────────────────────

/**
 * An HQ message from an organiser of the club (the caller found him an
 * owner or admin there). Nothing is read for an untagged message that is
 * not a card. Never throws: a failure leaves the message to the pipeline.
 */
export async function handleGuestCardHq(a: {
  orgId: string;
  organiserUserId: string;
  messageId: string;
  text: string;
  quotedText: string | null;
  tagged: boolean;
  now: Date;
}): Promise<DoorResult> {
  if (!a.tagged && !isContactCard(a.text)) return { kind: "not-mine" };
  try {
    const senderName = (await db.user.findUnique({ where: { id: a.organiserUserId }, select: { name: true } }))?.name ?? null;
    return await readAndAdd({ door: "hq", orgIds: [a.orgId], scope: `h:${a.orgId}`, senderUserId: a.organiserUserId, senderName, messageId: a.messageId, text: a.text, quotedText: a.quotedText, tagged: a.tagged, now: a.now });
  } catch (err) {
    console.error(`[guest-card] HQ ${a.messageId}: failed; left to the pipeline:`, err instanceof Error ? err.message : "failed");
    return { kind: "not-mine" };
  }
}

// ── A DM to MatchTime ──────────────────────────────────────────────────

/**
 * A DM from an organiser of one or more live clubs. A card from anyone who
 * organises nothing is swallowed (it is never an attendance or a question:
 * the card's container, not its words); every other DM is not-mine.
 */
export async function handleGuestCardDm(a: { userId: string; senderName: string | null; messageId: string; text: string; quotedText: string | null; now: Date }): Promise<DoorResult | { kind: "ignored-card" }> {
  const rows = await db.membership.findMany({
    where: { userId: a.userId, leftAt: null, role: { in: ["OWNER", "ADMIN"] }, ...ORDINARY_MEMBER_WHERE, org: { ...LIVE_STAGE_WHERE, whatsappBotEnabled: true } },
    select: { orgId: true },
  });
  const orgIds = rows.map((r) => r.orgId);
  if (orgIds.length === 0) return isContactCard(a.text) ? { kind: "ignored-card" } : { kind: "not-mine" };
  try {
    return await readAndAdd({ door: "dm", orgIds, scope: "dm", senderUserId: a.userId, senderName: a.senderName, messageId: a.messageId, text: a.text, quotedText: a.quotedText, tagged: true, now: a.now });
  } catch (err) {
    console.error(`[guest-card] DM ${a.messageId}: failed; left to the pipeline:`, err instanceof Error ? err.message : "failed");
    return { kind: "not-mine" };
  }
}
