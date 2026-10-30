/**
 * SELF-JOIN, SLICE 7 ("Decisions"): the PURE rules.
 * Plan: MDs/self-join-and-approval-plan-2026-09-28.md, sections 6.2, 6.4,
 * 7 (cap 8) and 12. The database half is `decideClub` and
 * `handleApproverDm` in club-approval.ts.
 *
 * No database, no clock but the one passed in, NO MODEL. The owner's
 * WhatsApp reply is read by the one DM reader (dm-intent.ts: `approve_club`
 * or `reject_club`, and the ref he named), and only from a number in
 * SELF_JOIN_APPROVER_PHONES, read off the DM's envelope (never a directory
 * lookup). Until 2026-10-30 an exact-phrase regex read it ("APPROVE 7KQ2"
 * as the whole message); Kemal: no string parsing. What stays here is the
 * check of the reader's answer against the facts.
 */
import { freePeriodStart } from "./club-billing-rules";
import { isClubLimitExempt } from "./club-limit-exempt";
import { formatLondon } from "./london-time";
import { e164Digits as platformPhoneDigits } from "./phone";

// ── The owner's reply ──────────────────────────────────────────────────

export type ApproverVerb = "approve" | "reject";
export interface ApproverCommand {
  verb: ApproverVerb;
  /** The club's ref (its connect code), uppercased. Null for a bare verb. */
  ref: string | null;
}

/** The DM reader's answer, as far as this file needs it. */
export interface ApproverRead {
  intent: string;
  /** The club ref the model says he named, as he wrote it; "" for none. */
  clubRef?: string;
}

/** A command, and a ref the model gave that his words do not hold. */
export type ApproverReadCommand = ApproverCommand & { unverifiedRef?: string };

/**
 * The reader's approve or reject, checked. A MODEL-OUTPUT VERIFIER, not a
 * reader of meaning: the ref counts only when it stands as a whole token in
 * what the owner wrote, or in the message of ours he swiped to reply
 * (`sources`). A ref the model gave that is in neither is returned as
 * `unverifiedRef` with no ref, and the caller decides nothing on it.
 * Null when the reader did not say approve or reject.
 */
export function approverCommandFromRead(read: ApproverRead, sources: ReadonlyArray<string | null | undefined>): ApproverReadCommand | null {
  const verb: ApproverVerb | null = read.intent === "approve_club" ? "approve" : read.intent === "reject_club" ? "reject" : null;
  if (!verb) return null;
  const ref = typeof read.clubRef === "string" ? read.clubRef.trim().toUpperCase() : "";
  if (!ref) return { verb, ref: null };
  const tokens = new Set(
    sources.flatMap((t) => (typeof t === "string" ? (t.toUpperCase().match(/[\p{L}\p{N}]+/gu) ?? []) : [])),
  );
  return tokens.has(ref) ? { verb, ref } : { verb, ref: null, unverifiedRef: ref };
}

/**
 * Is this DM from an approver? Exact match of the sender's phone (the one
 * the Pi forwarded, or the envelope's alt phone when the chat id was a
 * LID) against the approver list. A sender with no phone on the envelope
 * is never an approver: the owner page is the fallback (plan 6.2, 8).
 */
export function isApproverSender(
  sender: { phone?: string | null; senderAltPhone?: string | null },
  approvers: readonly string[],
): boolean {
  if (approvers.length === 0) return false;
  for (const raw of [sender.phone, sender.senderAltPhone]) {
    if (typeof raw !== "string" || !raw.trim()) continue;
    const d = platformPhoneDigits(raw);
    if (d && approvers.includes(d)) return true;
  }
  return false;
}

// ── Which club the reply is about ──────────────────────────────────────

export interface WaitingClub {
  orgId: string;
  /** The connect code, which is the ref in the owner's DM. */
  code: string;
  club: string;
}

export interface DecidedClub {
  code: string;
  club: string;
  status: "approved" | "rejected" | "suspended";
  decidedAt: Date | null;
}

export type ApproverTarget =
  | { kind: "decide"; target: WaitingClub }
  | { kind: "ambiguous"; waiting: WaitingClub[] }
  | { kind: "none-waiting" }
  | { kind: "already"; decided: DecidedClub }
  | { kind: "unknown-ref"; ref: string; waiting: WaitingClub[] };

/**
 * `waiting`: clubs pending, oldest first. `decided`: clubs whose request
 * carried this ref and has been decided, newest first.
 */
export function resolveApproverTarget(
  cmd: ApproverCommand,
  waiting: WaitingClub[],
  decided: DecidedClub[],
): ApproverTarget {
  if (cmd.ref === null) {
    if (waiting.length === 1) return { kind: "decide", target: waiting[0] };
    if (waiting.length === 0) return { kind: "none-waiting" };
    return { kind: "ambiguous", waiting };
  }
  const hit = waiting.find((w) => w.code === cmd.ref);
  if (hit) return { kind: "decide", target: hit };
  const done = decided.find((d) => d.code === cmd.ref);
  if (done) return { kind: "already", decided: done };
  return { kind: "unknown-ref", ref: cmd.ref, waiting };
}

// ── The one-line ack to the owner (English only, plan 6.2) ─────────────

export type OwnerAck =
  /** `held` (go-live slice S3): the approval left the club setting up,
   *  silent until its organiser says GO. */
  | { kind: "approved"; club: string; held?: boolean }
  | { kind: "rejected"; club: string }
  | { kind: "ambiguous"; waiting: WaitingClub[] }
  | { kind: "unknown-ref"; ref: string; waiting: WaitingClub[] }
  /** The reader gave a ref his words do not hold: nothing is decided. */
  | { kind: "ref-needed"; waiting: WaitingClub[] }
  | { kind: "none-waiting" }
  | { kind: "already"; decided: DecidedClub }
  | { kind: "group-taken"; club: string; takenBy: string };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "June", "July", "Aug", "Sept", "Oct", "Nov", "Dec"];

/** "28 Sept at 19:04", London wall clock. */
export function formatDecidedAt(d: Date): string {
  const month = MONTHS[Number(formatLondon(d, "M")) - 1];
  return `${formatLondon(d, "d")} ${month} at ${formatLondon(d, "HH:mm")}`;
}

const listWaiting = (w: WaitingClub[]) => w.map((c) => `${c.code} ${c.club}`).join(", ");
const countWord = (n: number) => (n === 2 ? "Two" : String(n));

/**
 * What the platform owner is told after an approval, by WhatsApp and on
 * /admin/clubs alike. `held` (go-live slice S3, SETUP_HOLD_ENABLED on):
 * no hello goes out. It is said at the moment of approval, BEFORE the
 * chat is read or the organiser's setup DM is queued, so it states only
 * what is true whatever happens next: the club is approved and silent,
 * the organiser is sent the setup message (it may still be refused) and
 * goes live by replying GO, and a problem is shown on /admin/health
 * (`SETUP_ALERT_KIND`). Not held: today's sentence.
 */
export function approvedOwnerText(club: string, held: boolean): string {
  return held
    ? `Approved ${club}. It stays silent in its group: its organiser is sent the setup message and goes live by replying GO. Any problem shows on the health page.`
    : `Approved ${club}. The hello goes out in the group within a few minutes.`;
}

export function ownerAckText(a: OwnerAck): string {
  switch (a.kind) {
    case "approved":
      return approvedOwnerText(a.club, a.held === true);
    case "rejected":
      return `Rejected ${a.club}. Leaving the group now.`;
    case "ambiguous":
      return `${countWord(a.waiting.length)} clubs are waiting: ${listWaiting(a.waiting)}. Reply APPROVE and the ref.`;
    case "unknown-ref":
      return a.waiting.length > 0
        ? `No club waiting with ref ${a.ref}. Waiting now: ${listWaiting(a.waiting)}.`
        : `No club waiting with ref ${a.ref}. Nothing else is waiting.`;
    case "ref-needed":
      return a.waiting.length > 0
        ? `Which club? Reply with its ref, for example APPROVE ${a.waiting[0].code}. Waiting now: ${listWaiting(a.waiting)}.`
        : "Which club? Reply with its ref. Nothing is waiting right now.";
    case "none-waiting":
      return "No clubs are waiting right now.";
    case "already": {
      const when = a.decided.decidedAt ? ` on ${formatDecidedAt(a.decided.decidedAt)}` : "";
      const verb = a.decided.status === "suspended" ? "approved and later turned off" : a.decided.status;
      return `${a.decided.club} was already ${verb}${when}.`;
    }
    case "group-taken":
      return `Can't approve ${a.club}: its group already belongs to ${a.takenBy}. Nothing changed. See matchtime.ai/admin/clubs.`;
  }
}

// ── Cap 8: DMs to members from a new club (plan section 7) ─────────────

export const NEW_CLUB_MEMBER_DMS_PER_DAY = 20;
export const NEW_CLUB_DM_WINDOW_DAYS = 28;

/**
 * Today's DM allowance for a club's members, or null for no cap. Only a
 * club approved THROUGH self-join (`approvedAt` set), in its first 28 days
 * from its first day (`freePeriodStart`: the day it went live out of the
 * setup hold, else its approval, which for a club that was never held is
 * the same moment). Every club that existed before self-join (Sutton FC)
 * has a NULL `approvedAt` and is never capped.
 */
export function newClubDmCap(
  org: { id?: string; approvedAt: Date | null; liveAt?: Date | null },
  now: Date,
): number | null {
  // A club listed in CLUB_LIMIT_EXEMPT_ORG_IDS is never capped.
  if (isClubLimitExempt(org.id)) return null;
  if (!org.approvedAt) return null;
  const age = now.getTime() - (freePeriodStart(org) ?? org.approvedAt).getTime();
  return age < NEW_CLUB_DM_WINDOW_DAYS * 24 * 60 * 60 * 1000 ? NEW_CLUB_MEMBER_DMS_PER_DAY : null;
}

/**
 * Keep at most `remaining` DM instructions, in order; hold the rest (they
 * are not claimed, so they come back on a later poll, tomorrow once the
 * day's allowance is spent). Group posts are never held here.
 *
 * `exempt` (DM_REPLY_PRIORITY_ENABLED on only, src/lib/dm-reply-priority.ts):
 * a DM it says yes to is a conversational reply. It is always kept and
 * does not use up the allowance. Omitted: today's behaviour exactly.
 */
export function holdDmsOverAllowance<T extends { kind: string }>(
  instructions: T[],
  remaining: number,
  exempt?: (instruction: T) => boolean,
): { keep: T[]; held: T[] } {
  let left = Math.max(0, remaining);
  const keep: T[] = [];
  const held: T[] = [];
  for (const i of instructions) {
    if (i.kind !== "dm") keep.push(i);
    else if (exempt?.(i)) keep.push(i);
    else if (left > 0) {
      keep.push(i);
      left--;
    } else held.push(i);
  }
  return { keep, held };
}

// ── The off switch (suspend) ───────────────────────────────────────────

export type SuspendRefusal = "not-approved" | "not-self-join" | "confirm-mismatch";

const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * May this club be turned off from the owner page? Only an APPROVED club
 * that came in through self-join (`approvedAt` set by its approval), and
 * only when the owner typed its name. A club that predates self-join
 * (Sutton FC: approved by the column default, `approvedAt` NULL) is
 * refused whatever is typed: the page never offers it, and this is the
 * check behind the page.
 */
export function suspendRefusal(
  org: { approvalStatus: string; approvedAt: Date | null; name: string },
  typedName: string | null | undefined,
): SuspendRefusal | null {
  if (org.approvalStatus !== "approved") return "not-approved";
  if (!org.approvedAt) return "not-self-join";
  if (typeof typedName !== "string" || !typedName.trim() || norm(typedName) !== norm(org.name)) {
    return "confirm-mismatch";
  }
  return null;
}
