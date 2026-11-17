/**
 * THE GUEST, ADDED IN ONE GO (Kemal, 2026-11-17). Thin I/O around the pure
 * rules (`rules.ts`) and the words (`copy.ts`):
 *
 *   1. WHO HE IS: his phone number is his identity. A number nobody has is
 *      a new person; this club's member is that member; this club's past
 *      guest is that guest; anybody else on MatchTime is never attached
 *      (`numberOwnerDecision`, the add-player guard `ensureOrgPlayer` uses).
 *   2. HIS NAME: his own name when he already has an account, else the name
 *      the organiser wrote, else the card's label cleaned (`chooseGuestName`).
 *   3. HIS PLACE: a GUEST of this club for this match, by the one guest
 *      writer (`partner-guest.ts` `placeOrganiserGuest`: the pool's guest
 *      marks, so he is not counted as a group member and the after-game
 *      flow treats him as a guest; the club's rule decides in or bench).
 *      A member of the club is put on the list as a member.
 *   4. ONE WELCOME DM per guest per match (`guestWelcomeKey`, claimed in
 *      the same transaction as its job): the game, the venue with its map
 *      link, the fee, his place, "Reply OUT", and that he can ask here.
 *      Never the group's invite link (he plays once before he joins).
 *      Held through the club's quiet hours like every unprompted DM.
 *   5. THE ORGANISER'S ONE REPLY, worded for where he asked.
 *
 * Never throws: a failure is logged (ids only) and he hears the plain line.
 */
import { db } from "../db";
import { normaliseLang, type Lang } from "../i18n/lang";
import { QUIET_HOURS_SELECT, messageHoursSendAfter, quietHoursOf } from "../message-hours";
import { placeOrganiserGuest } from "../partner-guest";
import { normaliseBenchPickMode } from "../squad-capacity";
import { guestWelcomeDm, organiserReply, type OrganiserReply } from "./copy";
import { loadGuestMatchFacts } from "./facts";
import { chooseGuestName, guestWelcomeKey, numberOwnerDecision, type GuestNameSource } from "./rules";

/** A guest named from a card keeps this marker until he messages MatchTime
 *  himself; then his own WhatsApp name replaces the phone-book label
 *  (`guest-dm.ts`). Same placeholder domain as every phone-only account. */
export const CARD_NAMED_EMAIL_PREFIX = "guest-card-";
const placeholderEmail = (source: GuestNameSource | null, digits: string) => `${source === "card" ? CARD_NAMED_EMAIL_PREFIX : "wa-"}${digits}@placeholder.matchtime`;

export interface AddGuestArgs {
  orgId: string;
  matchId: string;
  organiserUserId: string;
  /** E.164, or null when the card had no number. */
  phone: string | null;
  /** The name the organiser wrote, or null. */
  writtenName: string | null;
  /** The card's display name, or null. */
  cardName: string | null;
  /** The organiser's message id, for the attendance event. */
  sourceRef: string;
  now: Date;
}

export interface AddGuestOutcome {
  kind: OrganiserReply["kind"];
  reply: string;
  lang: Lang;
  userId: string | null;
  nameSource: GuestNameSource | null;
  dm: "sent" | "had" | "none";
}

export async function addGuest(a: AddGuestArgs): Promise<AddGuestOutcome> {
  const facts = await loadGuestMatchFacts(a.matchId).catch(() => null);
  const lang = normaliseLang(facts?.language);
  const done = (r: OrganiserReply, extra: Partial<AddGuestOutcome> = {}): AddGuestOutcome => {
    const out: AddGuestOutcome = { kind: r.kind, reply: organiserReply(lang, r), lang, userId: null, nameSource: null, dm: "none", ...extra };
    console.log(`[guest-card] match ${a.matchId}: ${out.kind}${out.userId ? ` user ${out.userId}` : ""}${out.nameSource ? ` (name from ${out.nameSource})` : ""}, dm ${out.dm}`);
    return out;
  };
  if (!facts || facts.orgId !== a.orgId) return done({ kind: "no-game" });
  if (!a.phone) return done({ kind: "no-number" });

  try {
    const existing = await db.user.findUnique({ where: { phoneNumber: a.phone }, select: { id: true, name: true } });
    const membership = existing
      ? await db.membership.findUnique({ where: { userId_orgId: { userId: existing.id, orgId: a.orgId } }, select: { guestMatchId: true, guestFromOrgId: true, guestVia: true, leftAt: true } })
      : null;
    const owner = numberOwnerDecision({ userExists: !!existing, membership });
    if (owner === "not-ours") return done({ kind: "not-ours" });

    const chosen = chooseGuestName({ written: a.writtenName, existing: existing?.name ?? null, card: a.cardName });
    if (!chosen.name) return done({ kind: "no-name" });
    const name = chosen.name;
    const digits = a.phone.replace(/^\+/, "");

    let userId = existing?.id ?? null;
    if (!userId) {
      try {
        userId = (
          await db.user.create({
            data: { name, email: placeholderEmail(chosen.source, digits), phoneNumber: a.phone, onboarded: false, isActive: true },
            select: { id: true },
          })
        ).id;
      } catch (err) {
        // The same number at the same instant (two doors at once): use it.
        userId = (await db.user.findUnique({ where: { phoneNumber: a.phone }, select: { id: true } }))?.id ?? null;
        if (!userId) throw err;
      }
    }
    // The organiser's own add: a stamp from an earlier Remove is cleared,
    // as the match page's Add does (`ensureMembership`).
    await db.membership.updateMany({ where: { userId, orgId: a.orgId, removedByOrganiserAt: { not: null } }, data: { removedByOrganiserAt: null } });

    const prior = await db.attendance.findUnique({ where: { matchId_userId: { matchId: a.matchId, userId } }, select: { status: true } });
    let kind: "in" | "bench" | "already-in" | "already-bench";
    if (prior?.status === "CONFIRMED") kind = "already-in";
    else if (prior?.status === "BENCH") kind = "already-bench";
    else {
      const placed = await placeOrganiserGuest({ userId, orgId: a.orgId, matchId: a.matchId, benchPickMode: facts.benchPickMode, organiserUserId: a.organiserUserId, sourceRef: a.sourceRef });
      if (placed.kind === "elsewhere") return done({ kind: "elsewhere", name }, { userId, nameSource: chosen.source });
      if (placed.kind !== "in" && placed.kind !== "bench") return done({ kind: "failed", name }, { userId, nameSource: chosen.source });
      kind = placed.kind;
    }

    const status: "in" | "bench" = kind === "in" || kind === "already-in" ? "in" : "bench";
    const dm = await sendWelcomeOnce({ orgId: a.orgId, matchId: a.matchId, userId, phoneDigits: digits, now: a.now, organiserUserId: a.organiserUserId, guestName: name, status, facts, lang });
    return done({ kind, name, kickoff: facts.kickoff, now: a.now, dm }, { userId, nameSource: chosen.source, dm });
  } catch (err) {
    console.error(`[guest-card] match ${a.matchId}: add failed:`, err instanceof Error ? err.message : "failed");
    return done({ kind: "failed", name: a.writtenName ?? a.cardName ?? "him" });
  }
}

/** The one welcome DM, claimed once per guest per match with its job. */
async function sendWelcomeOnce(a: {
  orgId: string;
  matchId: string;
  userId: string;
  phoneDigits: string;
  now: Date;
  organiserUserId: string;
  guestName: string;
  status: "in" | "bench";
  facts: NonNullable<Awaited<ReturnType<typeof loadGuestMatchFacts>>>;
  lang: Lang;
}): Promise<"sent" | "had"> {
  const [organiser, org] = await Promise.all([
    db.user.findUnique({ where: { id: a.organiserUserId }, select: { name: true } }),
    db.organisation.findUnique({ where: { id: a.orgId }, select: QUIET_HOURS_SELECT }),
  ]);
  const text = guestWelcomeDm(a.lang, {
    ...a.facts,
    guestName: a.guestName,
    organiser: organiser?.name ?? null,
    status: a.status,
    organiserPicks: normaliseBenchPickMode(a.facts.benchPickMode) === "organiser",
  });
  const sendAfter = messageHoursSendAfter(a.now, quietHoursOf(org));
  return db.$transaction(async (tx) => {
    const { count } = await tx.sentNotification.createMany({
      data: [{ key: guestWelcomeKey(a.matchId, a.userId), kind: "guest-card-welcome", matchId: a.matchId, targetUser: a.userId }],
      skipDuplicates: true,
    });
    if (count !== 1) return "had" as const;
    await tx.botJob.create({ data: { orgId: a.orgId, kind: "dm", phone: a.phoneDigits, text, matchId: a.matchId, ...(sendAfter ? { sendAfter } : {}) } });
    return "sent" as const;
  });
}
