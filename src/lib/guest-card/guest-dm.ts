/**
 * THE GUEST CARD BY DM (2026-11-17): both sides of a private chat.
 *
 *   THE ORGANISER: his contact card, or "add him for tonight", by DM. The
 *   guest card door (`door.ts`), for every live club he organises; his
 *   one reply comes back by DM.
 *
 *   THE GUEST: he is NOT in the club's WhatsApp group (a guest plays once
 *   before he joins, Kemal 2026-11-17), so everything he says comes by
 *   DM:
 *     - his own WhatsApp name replaces the phone-book label he was listed
 *       under, the first time he writes (a name the organiser wrote, or one
 *       he already had, is never replaced);
 *     - "OUT" (in any words: the DM availability reader,
 *       `resolveDmSelfAttendance`, the model every DM IN or OUT is read by)
 *       gives his place back through the guest writer, with one DM to him
 *       and one notice to the club (`guest-notice.ts`, by name only);
 *     - every other message carries on to the DM pipeline, where a
 *       question reaches the scoped answer about his club and his game
 *       (`dm-qa.ts` `pickQaOrgAndQuote` finds his guest club, and
 *       `unified-dm.ts` shows the answer his game: `guestGameBlock`).
 *
 * Engages only for an organiser of a live club or a guest with a live
 * place; for everybody else it is three indexed reads (his name, his organiser clubs, his guest places) and returns null.
 */
import { db } from "../db";
import { withOrgAiBudget } from "../ai-budget";
import { loadPartnerAskSettings } from "../club-partnership";
import { PARTNER_ASK_CUTOFF_DEFAULT_HOURS } from "../club-partnership-rules";
import { REPLY_PRIORITY } from "../dm-reply-priority";
import { resolveDmSelfAttendance } from "../dm-self-attendance";
import { GUEST_MEMBER_WHERE, ORDINARY_MEMBER_WHERE } from "../guest-membership";
import { tellClubAboutGuest } from "../guest-notice";
import { normaliseLang } from "../i18n/lang";
import { loadMatchAvailabilityFacts } from "../match-availability-context";
import { askWindows } from "../partner-ask-rules";
import { withdrawOrganiserGuest } from "../partner-guest";
import { pullOutResult } from "../pool/round-rules";
import { quoteForMatch, type QuotedBotMessage } from "../reply-context";
import { usableWhatsAppName } from "../whatsapp-name";
import { dayCommaTimeLabel } from "../i18n/dates";
import { formatGuestGameBlock } from "./context";
import { CARD_NAMED_EMAIL_PREFIX } from "./add";
import { guestOutDm, guestOutNotice } from "./copy";
import { handleGuestCardDm } from "./door";
import { isContactCard } from "./vcard";
import { loadGuestMatchFacts } from "./facts";

const LIVE = ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] as const;
export const GUEST_OUT_NOTICE_KIND = "guest-card-out" as const;

export interface LiveGuestGame {
  orgId: string;
  matchId: string;
  kickoff: Date;
  /** Placed by an organiser's card or words (no pool offer, no friend link). */
  byOrganiser: boolean;
}

/**
 * His live guest places, soonest first: a guest membership (any kind) for
 * a game that has not been played, where he is still on the list.
 */
export async function liveGuestGames(userId: string, now: Date): Promise<LiveGuestGame[]> {
  const mems = await db.membership.findMany({ where: { userId, leftAt: null, ...GUEST_MEMBER_WHERE }, select: { orgId: true, guestMatchId: true } });
  const out: LiveGuestGame[] = [];
  for (const m of mems) {
    if (!m.guestMatchId) continue;
    const [match, row, place] = await Promise.all([
      db.match.findUnique({ where: { id: m.guestMatchId }, select: { date: true, status: true, isHistorical: true } }),
      db.attendance.findUnique({ where: { matchId_userId: { matchId: m.guestMatchId, userId } }, select: { status: true } }),
      db.guestPlace.findUnique({ where: { matchId_userId: { matchId: m.guestMatchId, userId } }, select: { source: true, poolOfferId: true, friendLinkId: true } }),
    ]);
    if (!match || match.isHistorical || !(LIVE as readonly string[]).includes(match.status)) continue;
    // Until the game is over (a question on the night, "where do I park?").
    if (match.date.getTime() < now.getTime() - 3 * 3600_000) continue;
    if (!row || (row.status !== "CONFIRMED" && row.status !== "BENCH")) continue;
    out.push({ orgId: m.orgId, matchId: m.guestMatchId, kickoff: match.date, byOrganiser: !!place && place.source === "pool" && !place.poolOfferId && !place.friendLinkId });
  }
  return out.sort((a, b) => a.kickoff.getTime() - b.kickoff.getTime());
}

/**
 * HIS GAME, for the DM answer's context (`unified-dm.ts`): facts only, the
 * ones the welcome DM gave him, so "where is it?", "how much?" and "what
 * format?" are answered from the club's data. Null when he is not this
 * club's guest for a game still to come.
 */
export async function guestGameBlock(orgId: string, userId: string, now: Date): Promise<string | null> {
  const game = (await liveGuestGames(userId, now)).find((g) => g.orgId === orgId);
  if (!game) return null;
  const f = await loadGuestMatchFacts(game.matchId);
  if (!f) return null;
  const row = await db.attendance.findUnique({ where: { matchId_userId: { matchId: game.matchId, userId } }, select: { status: true } });
  return formatGuestGameBlock(f, row?.status ?? null);
}

/**
 * A CARD BY DM, AT THE DOOR (review of #621): before any other DM handler
 * reads the message. An organiser's card is held for his next words; anyone
 * else's is dropped. Either way the DM goes no further, so no reader, model
 * or stored row ever sees the card. Null for any DM that is not a card.
 */
export async function handleCardDmAtIntake(a: {
  text: string;
  phone: string | null | undefined;
  senderAltPhone: string | null | undefined;
  senderLid: string | null | undefined;
  authorName: string | null;
  waMessageId: string;
  now?: Date;
}): Promise<GuestCardDmResult> {
  if (!isContactCard(a.text)) return null;
  try {
    const { resolveSenderUserIds } = await import("../admin-group-link");
    const userIds = await resolveSenderUserIds({ phones: [a.phone, a.senderAltPhone], lid: a.senderLid ?? null });
    const r = await handleGuestCardDm({ userIds, senderName: a.authorName, messageId: a.waMessageId, text: a.text, quotedText: null, now: a.now ?? new Date() });
    return { handled: r.kind === "held" ? "guest-card-held" : "guest-card-ignored" };
  } catch (err) {
    console.error(`[guest-card] DM card ${a.waMessageId}: not held:`, err instanceof Error ? err.message : "failed");
    return { handled: "guest-card-ignored" };
  }
}

export type GuestCardDmResult = { handled: "guest-card-held" | "guest-card-ignored" | "guest-card-added" | "guest-card-out" } | null;

export async function handleGuestCardDms(a: {
  userId: string;
  authorName: string | null;
  text: string;
  waMessageId: string;
  /** His number without "+", for the replies. */
  replyPhone: string | null;
  quoted: QuotedBotMessage | null;
  /** The text of whatever his DM swipe-replies to (a card he shared). */
  quotedText: string | null;
  now?: Date;
}): Promise<GuestCardDmResult> {
  const now = a.now ?? new Date();

  // ── The organiser's side ──────────────────────────────────────────
  // (His card itself never reaches here: it is taken at the door,
  // `handleCardDmAtIntake`.)
  const user = await db.user.findUnique({ where: { id: a.userId }, select: { name: true } });
  const door = await handleGuestCardDm({ userIds: [a.userId], senderName: user?.name ?? a.authorName, messageId: a.waMessageId, text: a.text, quotedText: a.quotedText, now });
  if (door.kind === "held") return { handled: "guest-card-held" };
  if (door.kind === "ignored-card") return { handled: "guest-card-ignored" };
  if (door.kind === "answered") {
    if (a.replyPhone) await db.botJob.create({ data: { orgId: door.orgId, kind: "dm", phone: a.replyPhone, text: door.reply, ...REPLY_PRIORITY } });
    // "I'm in, and add him for tonight": the add is done and said; the rest
    // of his DM carries on through the DM pipeline (review of #621).
    if (door.also) return null;
    return { handled: "guest-card-added" };
  }

  // ── The guest's side ──────────────────────────────────────────────
  // Only a guest with no club of his own: another club's member's DMs
  // belong to his own club (review of #621).
  const own = await db.membership.count({ where: { userId: a.userId, leftAt: null, ...ORDINARY_MEMBER_WHERE } });
  if (own > 0) return null;
  const games = await liveGuestGames(a.userId, now);
  const mine = games.find((g) => g.byOrganiser);
  if (!mine) return null;
  await takeHisOwnName(a.userId, a.authorName);

  const facts = await loadMatchAvailabilityFacts({ userId: a.userId, matchId: mine.matchId, phone: a.replyPhone, quoted: quoteForMatch(a.quoted, mine.matchId) });
  const f = await loadGuestMatchFacts(mine.matchId);
  if (!f) return null;
  const lang = normaliseLang(f.language);
  const resolution = await withOrgAiBudget(mine.orgId, () =>
    resolveDmSelfAttendance({
      text: a.text,
      hasPendingPrompt: false,
      context: { ...facts, playerName: user?.name ?? a.authorName, clubName: f.club, matchName: f.club, matchWhen: dayCommaTimeLabel(lang, f.kickoff) },
    }),
  ).catch(() => ({ decision: null }) as { decision: null });
  if (resolution.decision !== "out") return null;

  const cutoff = askWindows(f.kickoff, (await loadPartnerAskSettings(mine.orgId))?.cutoffHours ?? PARTNER_ASK_CUTOFF_DEFAULT_HOURS).postBy;
  const done = await withdrawOrganiserGuest({ userId: a.userId, matchId: mine.matchId, orgId: mine.orgId, result: pullOutResult({ now, cutoff }), now });
  if (!done) return null;
  if (a.replyPhone) await db.botJob.create({ data: { orgId: mine.orgId, kind: "dm", phone: a.replyPhone, text: guestOutDm(lang, { club: f.club, kickoff: f.kickoff }), ...REPLY_PRIORITY } });
  try {
    const organiser = await whoBroughtHim(mine.matchId, a.userId);
    const line = guestOutNotice(lang, { name: user?.name ?? "", organiser, kickoff: f.kickoff });
    await tellClubAboutGuest({ orgId: mine.orgId, matchId: mine.matchId, key: `guest-card:${mine.matchId}:${a.userId}:out`, kind: GUEST_OUT_NOTICE_KIND, now, hqText: line, groupText: line });
  } catch (err) {
    console.error(`[guest-card] the club was not told of ${a.userId}'s OUT:`, err instanceof Error ? err.message : "failed");
  }
  console.log(`[guest-card] guest ${a.userId} gave his place back on match ${mine.matchId}`);
  return { handled: "guest-card-out" };
}

/** A guest listed under a phone-book label takes his own WhatsApp name the
 *  first time he writes. Once: the marker goes with it. Never throws. */
async function takeHisOwnName(userId: string, authorName: string | null): Promise<void> {
  const own = usableWhatsAppName(authorName);
  if (!own) return;
  try {
    const u = await db.user.findUnique({ where: { id: userId }, select: { email: true } });
    if (!u?.email?.startsWith(CARD_NAMED_EMAIL_PREFIX)) return;
    await db.user.updateMany({ where: { id: userId, email: u.email }, data: { name: own, email: u.email.replace(CARD_NAMED_EMAIL_PREFIX, "wa-") } });
    console.log(`[guest-card] guest ${userId} now listed under his own WhatsApp name`);
  } catch (err) {
    console.error(`[guest-card] guest ${userId}: own name not saved:`, err instanceof Error ? err.message : "failed");
  }
}

/** The organiser whose add put him on this match (its attendance event). */
async function whoBroughtHim(matchId: string, userId: string): Promise<string | null> {
  const ev = await db.attendanceEvent
    .findFirst({ where: { matchId, userId, cause: "admin-message", sourceRef: { startsWith: "guest-card:" } }, orderBy: { at: "desc" }, select: { actorUserId: true } })
    .catch(() => null);
  if (!ev?.actorUserId) return null;
  return (await db.user.findUnique({ where: { id: ev.actorUserId }, select: { name: true } }))?.name ?? null;
}
