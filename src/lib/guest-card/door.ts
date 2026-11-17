/**
 * BRINGING A GUEST: ONE STEP, THREE DOORS, ONE PATH (Kemal, 2026-11-17;
 * reworked after the review of #621).
 *
 * "Bringing a guest must be simple." An organiser (an owner or admin of
 * the club) shares the guest's WhatsApp contact card, or writes his name
 * and number, with words like "add him for tonight", in the players'
 * group, the organisers' group (HQ) or a DM to MatchTime. Each door calls
 * the same function here (`readAndAdd`), with the facts only that door
 * has; nothing is decided differently per door:
 *
 *   0. Every door takes a card's text aside BEFORE anything else reads the
 *      message (`intake.ts`): the rest of MatchTime, its models and its
 *      stored rows only ever see `CONTACT_CARD_LABEL`. Only this module
 *      reads a card, and only an organiser's.
 *   1. A CARD from an organiser is held (`hold.ts`) and nothing is said:
 *      it is the person his next words are about. A card from anyone else
 *      is noise: never held, never read, never routed (the 2026-06-11
 *      "Salman Shelly Ftbl" incident stays impossible).
 *   2. His next message (or one replying to the card, or one with a phone
 *      number in it) is read by the guest reader (`reader.ts`, the model):
 *      does it add someone, is it the card's person or someone he typed
 *      with a number, which game (or a day that is not on the list), and
 *      does it ask for anything else too. In HQ only a real tag is read.
 *   3. The people are added (`add.ts`), each the person the message is
 *      about: a typed number (checked against his words, `phoneWrittenIn`)
 *      is never swapped for a held card. A game that is not on the list,
 *      or several clubs with none named, is ASKED, never guessed; the card
 *      stays held for the answer. The organiser gets ONE reply where he
 *      asked. When the message also asks for something else ("I'm in, and
 *      add him"), the add is done first and the message carries on through
 *      the door's own pipeline for the rest (`also`).
 *
 * A held card is kept until an add uses it, or for its window, so "who is
 * this?" and then "add Sam Jones for tonight" works.
 */
import { db } from "../db";
import { isAiBudgetExceeded, withOrgAiBudget } from "../ai-budget";
import { LIVE_STAGE_WHERE } from "../club-setup-rules";
import { ORDINARY_MEMBER_WHERE } from "../guest-membership";
import { normaliseLang } from "../i18n/lang";
import { addGuest, type AddGuestOutcome } from "./add";
import { organiserReply } from "./copy";
import { loadComingGames } from "./facts";
import { heldCards, holdCards, spendHeldCards } from "./hold";
import { GUEST_ADD_FLOOR, readGuestAdd } from "./reader";
import { chooseGame, cleanCardName, hasPhoneNumberShape, isOrganiserMembership, phoneWrittenIn, shouldReadGuestAdd, typedGuestPhone, type GuestCardDoor } from "./rules";
import { CONTACT_CARD_LABEL, isContactCard, readContactCards, type ContactCard } from "./vcard";

export type DoorResult =
  /** An organiser's card: held, nothing said. */
  | { kind: "held" }
  /**
   * The request was read and acted on (or a question asked): the one
   * reply. `also`: the message asks for something else too, so it carries
   * on through the door's pipeline after the add, with this reply merged.
   */
  | { kind: "answered"; reply: string; orgId: string; added: number; also: boolean }
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
  /** His words, or the RAW card text taken aside at the door. */
  text: string;
  /** The RAW text of the message his message replies to, if any. */
  quotedText: string | null;
  tagged: boolean;
  now: Date;
}

const ADDED: ReadonlySet<AddGuestOutcome["kind"]> = new Set(["in", "bench", "already-in", "already-bench"]);

async function clubLanguage(orgId: string): Promise<string | null> {
  return (await db.organisation.findUnique({ where: { id: orgId }, select: { language: true } }))?.language ?? null;
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

  // WHO: each person the message is about. A typed number he wrote (checked
  // against his words) is that person, never a held card; the card's
  // person only when the message is about him.
  const typed = reading.typed.filter((t) => phoneWrittenIn(t.phone, m.text));
  const cardPeople = reading.card ? cards : [];
  // Nobody with a number or a card: a named add carries on to the
  // attendance engine, as it always has.
  if (typed.length === 0 && cardPeople.length === 0) return { kind: "not-mine" };

  // WHICH GAME: named, the soonest of one club's, or asked (never guessed).
  const choice = chooseGame(games, { n: reading.game, notListed: reading.gameNotListed });
  const askOrg = choice.kind === "game" ? choice.game.orgId : (games[0]?.orgId ?? m.orgIds[0]);
  const lang = normaliseLang(await clubLanguage(askOrg));
  const answered = (reply: string, added = 0): DoorResult => ({ kind: "answered", reply, orgId: askOrg, added, also: reading.also });
  if (choice.kind === "none") return answered(organiserReply(lang, { kind: "no-game" }));
  if (choice.kind === "ask-game") return answered(organiserReply(lang, { kind: "ask-game", games: games.filter((g) => g.orgId === askOrg).slice(0, 4) }));
  if (choice.kind === "ask-club") return answered(organiserReply(lang, { kind: "ask-club", clubs: [...new Set(games.map((g) => g.club))] }));
  const game = choice.game;

  const replies: string[] = [];
  let added = 0;
  let cardAdded = false;
  const add = async (p: { phone: string | null; writtenName: string | null; cardName: string | null }) =>
    addGuest({ orgId: game.orgId, matchId: game.matchId, organiserUserId: m.senderUserId, phone: p.phone, writtenName: p.writtenName, cardName: p.cardName, sourceRef: m.messageId, now: m.now });
  for (const t of typed) {
    const phone = typedGuestPhone(t.phone, lang);
    if (!phone) {
      replies.push(organiserReply(lang, { kind: "no-country-code" }));
      continue;
    }
    const out = await add({ phone, writtenName: t.name, cardName: null });
    replies.push(out.reply);
    if (ADDED.has(out.kind)) added++;
  }
  for (const c of cardPeople) {
    const out = await add({ phone: c.phone, writtenName: cardPeople.length === 1 ? reading.name : null, cardName: c.name });
    replies.push(out.reply);
    if (ADDED.has(out.kind)) {
      added++;
      cardAdded = true;
    }
  }
  // A held card is used once an add used it; until then (a refusal, a
  // question, a name still to come) it stays held for its window.
  if (cardAdded && quoted.length === 0) await spendHeldCards(held.keys);
  return answered(replies.join("\n"), added);
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
  /** His words, or the RAW card text taken aside at the door (`intake.ts`). */
  body: string;
  /** The RAW quoted text, a card included. */
  quotedBody: string | null;
  senderUserId: string | null;
  senderName: string | null;
  tagged: boolean;
  /** A late message (`late-message.ts`): never acted on here. */
  late: boolean;
}

export interface BatchConsumed {
  waMessageId: string;
  /** What is stored and shown as this message's text: a card is its label. */
  storedBody: string;
  reply: string | null;
  intent: string;
  reasoning: string;
}

/**
 * A batch of the players' group, in arrival order. Every card leaves the
 * batch as noise (an organiser's is held first); a request the guest
 * reader takes leaves it with its one reply, unless it also asks for
 * something else: then it stays, and its reply is merged into the
 * pipeline's (`merges`). A request written just before its card in one
 * batch finds it (cards are taken first). Everything else is untouched.
 */
export async function handleGuestCardsInBatch(a: {
  orgId: string;
  messages: BatchMessage[];
  now: Date;
}): Promise<{ consumed: BatchConsumed[]; merges: Map<string, string> }> {
  const consumed: BatchConsumed[] = [];
  const merges = new Map<string, string>();
  const organiser = new Map<string, boolean>();
  const isOrg = async (userId: string | null) => {
    if (!userId) return false;
    if (!organiser.has(userId)) organiser.set(userId, await organisesClub(userId, a.orgId));
    return organiser.get(userId)!;
  };
  const scope = `g:${a.orgId}`;
  const noise = (m: BatchMessage, why: string): BatchConsumed => ({ waMessageId: m.waMessageId, storedBody: CONTACT_CARD_LABEL, reply: null, intent: "noise", reasoning: `guest-card: ${why}` });
  const cardsFirst = [...a.messages].sort((x, y) => Number(isContactCard(y.body)) - Number(isContactCard(x.body)));
  for (const m of cardsFirst) {
    const card = isContactCard(m.body);
    try {
      const organiserSent = !m.late && (await isOrg(m.senderUserId));
      if (!organiserSent) {
        if (card) consumed.push(noise(m, "a contact card from someone who is not an organiser (or late): never read"));
        continue;
      }
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
      if (r.kind === "held") consumed.push(noise(m, "an organiser's contact card, held for his request"));
      else if (r.kind === "answered" && r.also) merges.set(m.waMessageId, r.reply);
      else if (r.kind === "answered") consumed.push({ waMessageId: m.waMessageId, storedBody: m.body, reply: r.reply, intent: "admin_command", reasoning: `guest-card: ${r.added} guest(s) added by an organiser` });
    } catch (err) {
      console.error(`[guest-card] ${m.waMessageId}: failed; left to the pipeline:`, err instanceof Error ? err.message : "failed");
      if (card) consumed.push(noise(m, "a contact card (the door failed): never read"));
    }
  }
  return { consumed, merges };
}

// ── HQ ─────────────────────────────────────────────────────────────────

/**
 * An HQ message from an organiser of the club (the caller found him an
 * owner or admin there), with its RAW text and quote. Nothing is read for
 * an untagged message that is not a card. Never throws: a failure leaves
 * the message to the pipeline.
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

/** The live clubs this user organises. */
export async function organisedClubIds(userId: string): Promise<string[]> {
  const rows = await db.membership.findMany({
    where: { userId, leftAt: null, role: { in: ["OWNER", "ADMIN"] }, ...ORDINARY_MEMBER_WHERE, org: { ...LIVE_STAGE_WHERE, whatsappBotEnabled: true } },
    select: { orgId: true },
  });
  return rows.map((r) => r.orgId);
}

/**
 * A DM from an organiser of one or more live clubs, with its RAW text and
 * quote. A card from anyone who organises nothing is dropped (never read);
 * every other DM from such a sender is not-mine.
 */
export async function handleGuestCardDm(a: { userIds: string[]; senderName: string | null; messageId: string; text: string; quotedText: string | null; now: Date }): Promise<
  (DoorResult & { userId?: string }) | { kind: "ignored-card" }
> {
  for (const userId of a.userIds) {
    const orgIds = await organisedClubIds(userId);
    if (orgIds.length === 0) continue;
    try {
      const r = await readAndAdd({ door: "dm", orgIds, scope: "dm", senderUserId: userId, senderName: a.senderName, messageId: a.messageId, text: a.text, quotedText: a.quotedText, tagged: true, now: a.now });
      return { ...r, userId };
    } catch (err) {
      console.error(`[guest-card] DM ${a.messageId}: failed; left to the pipeline:`, err instanceof Error ? err.message : "failed");
      return isContactCard(a.text) ? { kind: "ignored-card" } : { kind: "not-mine" };
    }
  }
  return isContactCard(a.text) ? { kind: "ignored-card" } : { kind: "not-mine" };
}
