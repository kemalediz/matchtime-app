/**
 * BRINGING A GUEST IN ONE STEP: THE RULES (Kemal, 2026-11-17). Pure, no db.
 *
 * An organiser shares a guest's WhatsApp contact card (or writes his name
 * and number) and says he is playing. These rules decide, on FACTS only,
 * whether that is read at all, which name he is listed under, whose number
 * may be attached, and the one welcome DM per guest per match. Whether the
 * words ASK for the add is the model's reading (`reader.ts`), never a test
 * on the words here.
 *
 * The two text checks in this file read data, not people: `hasPhoneNumberShape`
 * says a phone number is present in the message (the gate that a typed
 * name-and-number is worth one model read, like the card's envelope), and
 * `phoneWrittenIn` verifies the number the model returned is the one the
 * organiser wrote (the `refWrittenIn` pattern). `cleanCardName` tidies a
 * phone-book label; it reads no intent.
 */
import { guestSourceOf, isGuestMembership, type GuestMarks } from "../guest-membership";
import { e164Digits, normalisePhone } from "../phone";
import { isRawDigitName } from "../whatsapp-name";

/** A card and the organiser's words go together for this long. */
export const GUEST_CARD_WINDOW_MS = 30 * 60_000;

/** The doors a guest can be brought through. One rule for all three. */
export type GuestCardDoor = "players" | "hq" | "dm";

/** An OWNER or ADMIN of the club, still a member, and not a guest. */
export function isOrganiserMembership(m: (GuestMarks & { role: string; leftAt: Date | null }) | null | undefined): boolean {
  if (!m || m.leftAt) return false;
  if (isGuestMembership(m)) return false;
  return m.role === "OWNER" || m.role === "ADMIN";
}

/**
 * Whether the guest reader is asked about a message at all. Only an
 * organiser's, and only with something to add: a card he just shared, a
 * card his message replies to, or a phone number in his words. In HQ only
 * a real tag (HQ is quiet unless tagged, 2026-10-31); the card itself is
 * held untagged, the request must tag.
 */
export function shouldReadGuestAdd(f: {
  organiser: boolean;
  cardsHeld: number;
  quotedCard: boolean;
  numberInText: boolean;
  tagged: boolean;
  door: GuestCardDoor;
}): boolean {
  if (!f.organiser) return false;
  if (f.door === "hq" && !f.tagged) return false;
  return f.cardsHeld > 0 || f.quotedCard || f.numberInText;
}

// ── The name ───────────────────────────────────────────────────────────

/** Words people put after a name in their phone book to say where they
 *  know someone from. Only ever dropped from the END of a card's label. */
const PHONE_BOOK_SUFFIXES = new Set([
  "ftbl",
  "fball",
  "football",
  "footy",
  "footie",
  "soccer",
  "fc",
  "futsal",
  "5aside",
  "5-a-side",
  "6aside",
  "6-a-side",
  "7aside",
  "7-a-side",
  "8aside",
  "8-a-side",
  "11aside",
  "11-a-side",
  "fives",
  "sevens",
  "5s",
  "7s",
  "halısaha",
  "halisaha",
  "futbol",
  "maç",
  "mac",
]);

/**
 * A card's display name, cleaned of obvious phone-book additions: bracketed
 * notes, emoji, trailing numbers and football labels at the end. Null when
 * nothing that can be a name is left (a bare number, a lone label).
 */
export function cleanCardName(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  let s = raw
    .replace(/\(.*?\)|\[.*?\]|\{.*?\}/g, " ")
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!s || isRawDigitName(s)) return null;
  const words = s.split(" ");
  while (words.length > 0) {
    const last = words[words.length - 1].toLowerCase().replace(/[.,;:!-]+$/, "");
    if (PHONE_BOOK_SUFFIXES.has(last) || /^\d+$/.test(last) || last === "") words.pop();
    else break;
  }
  s = words.join(" ").trim();
  if (s.length < 2 || isRawDigitName(s)) return null;
  return s;
}

export type GuestNameSource = "existing" | "written" | "card";

/**
 * The name he is listed under. His own name on MatchTime when he already
 * has an account (an account is never renamed from someone else's phone
 * book or words), else the name the organiser wrote, else the card's
 * label, cleaned. A guest named from a card is renamed to his own WhatsApp
 * profile name the first time he messages MatchTime (`guest-dm.ts`).
 */
export function chooseGuestName(p: { written: string | null; existing: string | null; card: string | null }): { name: string | null; source: GuestNameSource | null } {
  const existing = p.existing?.trim();
  if (existing && !isRawDigitName(existing)) return { name: existing, source: "existing" };
  const written = p.written?.trim().replace(/\s+/g, " ");
  if (written && written.length >= 2 && !isRawDigitName(written)) return { name: written, source: "written" };
  const card = cleanCardName(p.card);
  if (card) return { name: card, source: "card" };
  return { name: null, source: null };
}

// ── The number ─────────────────────────────────────────────────────────

/**
 * WHOSE NUMBER MAY BE ATTACHED (the add-player guard, `ensureOrgPlayer` in
 * `src/app/actions/players.ts`, which uses this too): a number nobody has
 * is a new person; a number of this club's own member is that member; a
 * number of this club's past or present POOL guest is that guest again,
 * unless he is another club's member now. Anybody else on MatchTime is
 * never attached and never named ("not-ours"): another club's member, a
 * partner guest (he has a home club, and is never made this club's pool
 * guest, review of #621), or someone with no tie to this club. The web
 * form also refuses a guest (it would make him an ordinary member).
 */
export function numberOwnerDecision(p: {
  userExists: boolean;
  membership: (GuestMarks & { leftAt?: Date | null }) | null;
  /** He is a current ordinary member of another club. */
  memberElsewhere?: boolean;
}): "new" | "member" | "guest" | "not-ours" {
  if (!p.userExists) return "new";
  if (!p.membership) return "not-ours";
  if (!isGuestMembership(p.membership)) return "member";
  if (guestSourceOf(p.membership) === "partner") return "not-ours";
  return p.memberElsewhere ? "not-ours" : "guest";
}

/**
 * A number the organiser typed, as E.164, read in the club's country: the
 * UK forms `normalisePhone` reads, any number with its country code ("+"
 * or "00"), and a Turkish club's local mobile ("0532 123 45 67", +90).
 * Null when there is no country to read it in: the organiser is asked to
 * send it with the country code, never left without a word.
 */
export function typedGuestPhone(raw: string | null | undefined, lang: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  const digits = raw.replace(/[^\d+]/g, "");
  if (digits.startsWith("+") || digits.startsWith("00")) {
    const d = e164Digits(digits.startsWith("+") ? digits : `+${digits.slice(2)}`);
    return d ? `+${d}` : null;
  }
  const uk = normalisePhone(raw);
  if (uk && uk.startsWith("+44")) return uk;
  if (lang === "tr" && /^0?5\d{9}$/.test(digits)) return `+90${digits.replace(/^0/, "")}`;
  return null;
}

/** A run of 10 to 15 digits (spaces, dashes, dots, brackets and a leading
 *  "+" allowed between them): a phone number is present to be read. */
export function hasPhoneNumberShape(text: string | null | undefined): boolean {
  if (typeof text !== "string") return false;
  const runs = text.match(/\+?\d[\d\s().-]{8,22}\d/g) ?? [];
  return runs.some((r) => {
    const digits = r.replace(/\D/g, "");
    return digits.length >= 10 && digits.length <= 15;
  });
}

/** The national significant digits: what is left after "+44", "0044" or "0". */
function significant(digits: string): string {
  if (digits.startsWith("44")) return digits.slice(2);
  if (digits.startsWith("0")) return digits.replace(/^0+/, "");
  return digits;
}

/** The model's number is written in the message: its significant digits
 *  appear in the message's digits. A verifier on the model's answer. */
export function phoneWrittenIn(phone: string | null | undefined, text: string): boolean {
  const want = significant((phone ?? "").replace(/\D/g, ""));
  if (want.length < 9) return false;
  const runs = (text.match(/\+?\d[\d\s().-]*\d/g) ?? []).map((r) => significant(r.replace(/\D/g, "")));
  return runs.some((r) => r.endsWith(want) || (want.endsWith(r) && r.length >= 9));
}

// ── The game ───────────────────────────────────────────────────────────

/**
 * The game a request is for (review of #621: never guessed). The game the
 * model named; the soonest when none is named and every game is one
 * club's; "ask-game" when the message names a day or game that is not on
 * the list; "ask-club" when none is named and the games are several clubs'
 * (an organiser of two clubs, by DM).
 */
export function chooseGame<T extends { orgId: string }>(
  games: readonly T[],
  r: { n: number; notListed: boolean },
): { kind: "game"; game: T } | { kind: "ask-game" } | { kind: "ask-club" } | { kind: "none" } {
  if (games.length === 0) return { kind: "none" };
  if (r.notListed) return { kind: "ask-game" };
  if (Number.isInteger(r.n) && r.n >= 1) return r.n <= games.length ? { kind: "game", game: games[r.n - 1] } : { kind: "ask-game" };
  if (new Set(games.map((g) => g.orgId)).size > 1) return { kind: "ask-club" };
  return { kind: "game", game: games[0] };
}

// ── Once ───────────────────────────────────────────────────────────────

/** The one welcome DM per guest per match: its `SentNotification` key. */
export function guestWelcomeKey(matchId: string, userId: string): string {
  return `guest-card-welcome:${matchId}:${userId}`;
}
