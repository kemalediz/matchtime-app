/**
 * SELF-JOIN, SLICE 5 (the connect DM): the PURE rules.
 * Plan: MDs/self-join-and-approval-plan-2026-09-28.md, sections 2.2, 4.2,
 * 5.3, 5.4 and cap 6 of section 7.
 *
 * The organiser taps "Add MatchTime to WhatsApp" and sends the prefilled
 * "Connect Riverside FC, code 7KQ2" (Turkish: "Riverside FC kulübünü bağla,
 * kod 7KQ2"). This file reads the code out of whatever arrived and decides
 * what the DM does. No database, no clock, NO MODEL: the handler that uses
 * it (connect-dm.ts) runs at the top of dm-reply, before every model path.
 *
 * The code is a pointer, not the proof. The proof is that the DM came from
 * the phone the organiser signed up with, read off the message envelope
 * (the Pi forwards it; nothing here asks WhatsApp's directory).
 */
import { CONNECT_CODE_ALPHABET } from "./club-connect-rules";

// ── The numbers ─────────────────────────────────────────────────────────

/** Cap 6: new groups linked across the whole site per London day, counted
 *  at the connect DM (plan section 7). */
export const MAX_GROUP_LINKS_PER_DAY = 5;
/** After a verified DM, the organiser has 24 hours to add MatchTime. */
export const ADD_WINDOW_MS = 24 * 60 * 60 * 1000;
/** A code sent from another number is recorded (the organiser's card shows
 *  the masked number) at most once a minute per code, so a burst from a
 *  stranger cannot keep rewriting the card. It never gets a reply. */
export const MISMATCH_THROTTLE_MS = 60 * 1000;

// ── Reading the code ────────────────────────────────────────────────────

const CODE_CHARS = CONNECT_CODE_ALPHABET.replace(/[A-Z]/g, (c) => c + c.toLowerCase());
/**
 * "code" or "kod" (Turkish; also "kodu", "kodum", the forms a person
 * editing the text may use), then any punctuation or spacing, then four
 * characters from the code alphabet standing alone. Case does not matter.
 */
const CODE_RE = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:code|kodum|kodu|kod)(?![\\p{L}\\p{N}])[^\\p{L}\\p{N}]*([${CODE_CHARS}]{4})(?![\\p{L}\\p{N}])`,
  "giu",
);

/**
 * Every code-shaped token after "code"/"kod", uppercased, LAST FIRST, no
 * repeats. Last first because the prefilled text ends with the code: a club
 * called "Kod Team" puts "TEAM" earlier in the same line. The handler takes
 * the first candidate that names a real connect request, so the club name,
 * edited or not, is never trusted.
 */
export function connectCodeCandidates(text: string | null | undefined): string[] {
  if (typeof text !== "string" || text.length === 0 || text.length > 500) return [];
  const found = [...text.matchAll(CODE_RE)].map((m) => m[1].toUpperCase());
  const out: string[] = [];
  for (const c of found.reverse()) if (!out.includes(c)) out.push(c);
  return out;
}

// ── Identities off the envelope ─────────────────────────────────────────

/** A WhatsApp LID as bare digits: "123@lid", "123:4@lid" or "123" all give
 *  "123". Null for anything else. Never a phone number. */
export function lidDigits(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  const m = /^(\d{6,20})(?::\d+)?(?:@lid)?$/.exec(s);
  return m ? m[1] : null;
}

/** "+44 77** ***123" for a UK mobile (the plan's card example); the country
 *  code, two digits, and the last three otherwise. */
export function maskPhoneForCard(digits: string): string {
  const d = digits.replace(/\D/g, "");
  const uk = /^44(\d{2})\d+(\d{3})$/.exec(d);
  if (uk) return `+44 ${uk[1]}** ***${uk[2]}`;
  const tr = /^90(\d{2})\d+(\d{3})$/.exec(d);
  if (tr) return `+90 ${tr[1]}** ***${tr[2]}`;
  if (d.length < 8) return "+***";
  return `+${d.slice(0, d.length - 8)}** ***${d.slice(-3)}`;
}

// ── The decision ────────────────────────────────────────────────────────

/** The columns of the matched `ClubConnect` (and its club) the rule reads. */
export interface ConnectDmRow {
  status: string;
  /** The organiser's verified sign-up phone, digits. */
  phone: string;
  expiresAt: Date;
  addWindowEndsAt: Date | null;
  dmLid: string | null;
  lastMismatchAt: Date | null;
  orgApprovalStatus: string;
}

export interface ConnectDmSender {
  /** Phone digits read off the envelope (the JID, its alt, the local LID
   *  store). Usually one; empty when the sender's number was hidden. */
  phones: string[];
  /** Bare LID digits, when the envelope carried one. */
  lid: string | null;
}

export type ConnectDmReply = "connected" | "already-connected" | "expired" | "site-cap";

export type ConnectDmDecision =
  /** Bind the request to this chat. `dmPhoneMatched` is null when the phone
   *  was hidden and only the LID is known (flagged to the owner later). */
  | { action: "verify"; dmPhone: string | null; dmPhoneMatched: true | null }
  /** Would verify, but cap 6 is full today. */
  | { action: "site-cap" }
  /** The code came from another number: record it, never reply. */
  | { action: "mismatch"; masked: string }
  /** One reply to the organiser's sign-up phone. */
  | { action: "reply"; reply: "already-connected" | "expired" }
  /** Handled, and silent. */
  | { action: "ignore"; reason: string };

/** The status the row really has now (expiry is written lazily). */
export function effectiveConnectStatus(row: Pick<ConnectDmRow, "status" | "expiresAt" | "addWindowEndsAt">, now: Date): string {
  const t = now.getTime();
  if (row.status === "issued" && row.expiresAt.getTime() <= t) return "expired";
  if (row.status === "dm_verified" && row.addWindowEndsAt && row.addWindowEndsAt.getTime() <= t) return "expired";
  return row.status;
}

/**
 * What a DM carrying this row's code does (plan 5.3). `linksToday` is cap
 * 6's count so far; the caller re-decides under a lock before verifying.
 */
export function decideConnectDm(args: {
  row: ConnectDmRow;
  sender: ConnectDmSender;
  now: Date;
  linksToday: number;
}): ConnectDmDecision {
  const { row, sender, now, linksToday } = args;
  const status = effectiveConnectStatus(row, now);
  const fromOrganiser = sender.phones.includes(row.phone);
  const otherPhone = fromOrganiser ? null : (sender.phones[0] ?? null);

  switch (status) {
    case "issued": {
      if (row.orgApprovalStatus !== "draft") return { action: "ignore", reason: "club-not-draft" };
      if (otherPhone) {
        if (row.lastMismatchAt && now.getTime() - row.lastMismatchAt.getTime() < MISMATCH_THROTTLE_MS) {
          return { action: "ignore", reason: "mismatch-throttled" };
        }
        return { action: "mismatch", masked: maskPhoneForCard(otherPhone) };
      }
      if (!fromOrganiser && !sender.lid) return { action: "ignore", reason: "no-sender-identity" };
      if (linksToday >= MAX_GROUP_LINKS_PER_DAY) return { action: "site-cap" };
      return fromOrganiser
        ? { action: "verify", dmPhone: row.phone, dmPhoneMatched: true }
        : { action: "verify", dmPhone: null, dmPhoneMatched: null };
    }
    case "dm_verified": {
      const sameSender = fromOrganiser || (sender.phones.length === 0 && !!sender.lid && sender.lid === row.dmLid);
      return sameSender
        ? { action: "reply", reply: "already-connected" }
        : { action: "ignore", reason: "verified-by-another-sender" };
    }
    case "expired":
    case "superseded":
      return fromOrganiser ? { action: "reply", reply: "expired" } : { action: "ignore", reason: "code-expired" };
    default:
      // group_linked, closed: the code has done its job. The organiser's
      // card says where things stand; slice 6 sends the ack for the add.
      return { action: "ignore", reason: `code-${status}` };
  }
}
