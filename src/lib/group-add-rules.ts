/**
 * SELF-JOIN, SLICE 6 (group add linking): the PURE rules.
 * Plan: MDs/self-join-and-approval-plan-2026-09-28.md, sections 2.3, 5.5,
 * 5.6 and 6.1. The database half is group-add.ts.
 *
 * MatchTime was added to a WhatsApp group. Which organiser's connect
 * request does that add belong to, and how sure are we? This file answers
 * from what the Pi read off the add (the adder's phone and LID, the
 * participant snapshot), and nothing else: no directory lookups, no
 * clock but the one passed in, NO MODEL.
 *
 * The matching rule, in order (plan 2.3):
 *
 *   phone   the adder's phone is the organiser's verified sign-up phone
 *           (an `issued` request counts: a phone-matched add proves the
 *           number on its own, plan 4.2);
 *   lid     the adder's LID is the one the organiser's connect DM came
 *           from (only a DM-verified request has one);
 *   otherwise, only DM-verified requests, and only one whose organiser
 *   is SEEN in the group (by phone, or by the DM's LID):
 *     other-organiser-present   the adder is known and is somebody else;
 *     unknown                   no adder at all, or a LID nobody can map.
 *   Exactly one such request, or the add is unsolicited.
 *
 * "Organiser not in the group and the adder is somebody else" is NOT
 * linked to whichever request happens to be open: with several clubs
 * connecting each day, that would pin a stranger's group on an organiser
 * who never saw it, and a REJECT there would be final for them. It is
 * recorded as unsolicited instead (silent, left after 48 hours), and the
 * organiser, whose card still says "add MatchTime to your group", adds it
 * themselves. `mismatch` stays in the vocabulary and in the owner DM's
 * wording for the owner page, but this slice never produces it.
 */
import { effectiveConnectStatus, lidDigits } from "./connect-dm-rules";
import { formatPhoneForDisplay } from "./club-connect-rules";

// ── The numbers ─────────────────────────────────────────────────────────

/** Decision 3: MatchTime leaves a group nobody asked it into after 48 hours. */
export const UNSOLICITED_AUTO_LEAVE_MS = 48 * 60 * 60 * 1000;

// ── The evidence ────────────────────────────────────────────────────────

export type AdderMatch = "phone" | "lid" | "other-organiser-present" | "unknown" | "mismatch";

export interface AddEvidence {
  /** The adder's phone, digits. Null when WhatsApp did not say. */
  addedByPhone: string | null;
  /** The adder's LID, bare digits. Null when the author was phone-addressed. */
  addedByLid: string | null;
  /** Who is in the group (the bot excluded), as digits. */
  participants: Array<{ phone: string | null; lid: string | null }>;
  /** Found by the reconnect sweep rather than by an add event: no adder. */
  discovered: boolean;
}

/** Phone digits, 8 to 15 of them, or null. A LID is never a phone. */
export function phoneDigitsOf(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (/@lid\b/.test(raw)) return null;
  const d = raw.replace(/@c\.us$|@s\.whatsapp\.net$/, "").replace(/\D/g, "");
  return /^[1-9]\d{7,14}$/.test(d) ? d : null;
}

/** The Pi's bot-added body, read defensively into evidence. */
export function addEvidenceFrom(body: {
  addedByPhone?: unknown;
  addedByLid?: unknown;
  participants?: unknown;
  discovered?: unknown;
}): AddEvidence {
  const participants: AddEvidence["participants"] = [];
  for (const p of Array.isArray(body.participants) ? body.participants : []) {
    if (!p || typeof p !== "object") continue;
    const o = p as Record<string, unknown>;
    const phone = phoneDigitsOf(o.phone);
    const lid = lidDigits(typeof o.lidId === "string" ? o.lidId : null);
    if (phone || lid) participants.push({ phone, lid });
  }
  return {
    addedByPhone: phoneDigitsOf(body.addedByPhone),
    addedByLid: lidDigits(typeof body.addedByLid === "string" ? body.addedByLid : null),
    participants,
    discovered: body.discovered === true,
  };
}

// ── The decision ────────────────────────────────────────────────────────

/** The columns of a connect request the matcher reads. */
export interface LinkCandidate {
  id: string;
  status: string;
  /** The organiser's verified sign-up phone, digits. */
  phone: string;
  /** The LID the connect DM came from, bare digits. */
  dmLid: string | null;
  issuedAt: Date;
  expiresAt: Date;
  addWindowEndsAt: Date | null;
}

export type LinkDecision =
  | { link: true; connectId: string; adderMatch: AdderMatch; organiserPresent: boolean }
  | { link: false; reason: "no-match" | "ambiguous" };

function newestFirst(a: LinkCandidate, b: LinkCandidate): number {
  return b.issuedAt.getTime() - a.issuedAt.getTime();
}

/**
 * THE PROOF THAT THE ADDER IS THE ORGANISER, one rule for every path that
 * needs it (the matched add below, and the relink after a re-add):
 *
 *   by phone   the adder's phone is the organiser's verified sign-up phone;
 *   by LID     the adder's LID is the one the organiser's connect DM came
 *              from. `dmLid` is written by a verified connect DM and by
 *              nothing else, so a request that has one was DM-verified.
 *
 * Being IN the group is not this proof, and neither is a missing adder.
 */
export function adderIsOrganiserByPhone(ev: AddEvidence, c: { phone: string }): boolean {
  return !ev.discovered && ev.addedByPhone !== null && c.phone === ev.addedByPhone;
}

export function adderIsOrganiserByLid(ev: AddEvidence, c: { dmLid: string | null }): boolean {
  return !ev.discovered && ev.addedByLid !== null && c.dmLid !== null && c.dmLid === ev.addedByLid;
}

function organiserIn(c: LinkCandidate, ev: AddEvidence): boolean {
  return ev.participants.some((p) => (p.phone !== null && p.phone === c.phone) || (p.lid !== null && p.lid === c.dmLid));
}

/**
 * Which request this add belongs to. `candidates` may hold anything; only
 * requests still open NOW (an unexpired `issued` code, or a `dm_verified`
 * one inside its 24-hour add window) are considered.
 */
export function decideGroupAddLink(ev: AddEvidence, candidates: LinkCandidate[], now: Date): LinkDecision {
  const open = candidates
    .filter((c) => {
      const s = effectiveConnectStatus(c, now);
      return s === "issued" || s === "dm_verified";
    })
    .sort(newestFirst);

  const byPhone = open.find((c) => adderIsOrganiserByPhone(ev, c));
  if (byPhone) return { link: true, connectId: byPhone.id, adderMatch: "phone", organiserPresent: true };
  const byLid = open.find((c) => c.status === "dm_verified" && adderIsOrganiserByLid(ev, c));
  if (byLid) return { link: true, connectId: byLid.id, adderMatch: "lid", organiserPresent: true };

  const verified = open.filter((c) => c.status === "dm_verified");
  const present = verified.filter((c) => organiserIn(c, ev));
  if (present.length > 1) return { link: false, reason: "ambiguous" };
  if (present.length === 0) return { link: false, reason: "no-match" };
  const adderKnown = !ev.discovered && !!ev.addedByPhone;
  return {
    link: true,
    connectId: present[0].id,
    adderMatch: adderKnown ? "other-organiser-present" : "unknown",
    organiserPresent: true,
  };
}

// ── Relink after a re-add (owner's decision, 2026-10-11) ────────────────
//
// The organiser removes MatchTime from the group while the club waits for
// approval (to switch on WhatsApp's "Message history", say) and adds it
// straight back, without going to the website for a new code. The removal
// returned the club to draft and deleted the captured chat; the code is
// long expired; so no open request matches and the add used to be
// unsolicited: silent, nothing stored, left after 48 hours, nobody told.
//
// THE RULE. An add that matched no open request links the SAME connect
// request again when ALL of the following hold. It is asked BEFORE the
// admin-group rule: the organiser already proved this group is the club's,
// so it stays the club's even when the organiser also runs an approved
// club, or a member of the group is an admin of one with a link code open.
// When it does not hold, the admin-group rule and then "unsolicited" apply
// exactly as before.
//
//   1. the request names THIS group, is `group_linked` and has
//      `botRemovedAt` set: it is the link MatchTime was removed from. Of
//      several such rows only the one removed most recently is looked at;
//   2. the removal was less than RELINK_AFTER_REMOVAL_MS ago;
//   3. its club is still a draft (never pending, approved, rejected or
//      suspended; a deleted club has no row);
//   4. the club has no NEWER connect request, of any status. Once the
//      organiser has asked for a new code, the code flow owns the club and
//      its card; this rule never revives an older request beside it;
//   5. the ADDER is that request's organiser, by phone or by connect-DM
//      LID (`adderIsOrganiserByPhone` / `adderIsOrganiserByLid`, the very
//      proof a matched add uses). An add by anyone else, an add with no
//      adder, and a group found by the reconnect sweep never relink,
//      whoever is in the group.
//
// Anything else stays unsolicited exactly as before.

/**
 * How long after MatchTime was removed a re-add by the organiser still
 * links the same request. 24 hours: the length of the add window a verified
 * connect DM opens (ADD_WINDOW_MS in connect-dm-rules.ts). The removal is
 * treated as putting the organiser back at that step, "verified, now add
 * MatchTime to your group", for the time that step always allows. Long
 * enough for "I took it out last night and put it back this morning";
 * short enough that a group dropped days ago cannot be pinned on a club
 * again without a fresh code. Measured from `botRemovedAt`, never from the
 * first link, so each removal opens one window and no more.
 */
export const RELINK_AFTER_REMOVAL_MS = 24 * 60 * 60 * 1000;

/** The columns of a connect request (and its club) the relink rule reads. */
export interface RelinkCandidate {
  id: string;
  groupId: string | null;
  status: string;
  botRemovedAt: Date | null;
  /** The organiser's verified sign-up phone, digits. */
  phone: string;
  /** The LID the connect DM came from, bare digits. */
  dmLid: string | null;
  orgApprovalStatus: string;
  /** The club has another connect request issued at or after this one. */
  newerRequestExists: boolean;
}

export type RelinkDecision =
  | { relink: true; connectId: string; adderMatch: "phone" | "lid"; removedAt: Date }
  | {
      relink: false;
      reason: "no-removed-link" | "outside-window" | "club-not-draft" | "newer-request" | "adder-not-organiser";
    };

export function decideRelinkAfterReAdd(
  ev: AddEvidence,
  groupId: string,
  candidates: RelinkCandidate[],
  now: Date,
): RelinkDecision {
  const removed = candidates
    .filter(
      (c): c is RelinkCandidate & { botRemovedAt: Date } =>
        c.groupId === groupId && c.status === "group_linked" && c.botRemovedAt !== null,
    )
    .sort((a, b) => b.botRemovedAt.getTime() - a.botRemovedAt.getTime());
  const c = removed[0];
  if (!c) return { relink: false, reason: "no-removed-link" };
  if (now.getTime() - c.botRemovedAt.getTime() >= RELINK_AFTER_REMOVAL_MS) return { relink: false, reason: "outside-window" };
  if (c.orgApprovalStatus !== "draft") return { relink: false, reason: "club-not-draft" };
  if (c.newerRequestExists) return { relink: false, reason: "newer-request" };
  const adderMatch = adderIsOrganiserByPhone(ev, c) ? "phone" : adderIsOrganiserByLid(ev, c) ? "lid" : null;
  if (!adderMatch) return { relink: false, reason: "adder-not-organiser" };
  return { relink: true, connectId: c.id, adderMatch, removedAt: c.botRemovedAt };
}

/**
 * The dedupe keys of ONE relink. The organiser's ack and the owner's DM
 * are each sent once per refId, ever, and the first link used the bare
 * request id. A relink is a new "club waiting", so it gets its own keys,
 * built from the removal it undoes: a second removal and re-add has a
 * different `botRemovedAt` and sends again, while the same add delivered
 * twice (the Pi retries) builds the same keys and sends once.
 */
export function relinkRefIds(connectId: string, removedAt: Date): { ownerDm: string; organiserAck: string } {
  const stamp = removedAt.toISOString();
  return { ownerDm: `${connectId}:relink:${stamp}`, organiserAck: `${connectId}:in-group:relink:${stamp}` };
}

// ── The owner's approval DM (plan 6.1) ──────────────────────────────────
// English only: owner-facing copy, not player-facing.

/** "Added by: ...", naming which rule applied. */
export function adderLine(match: AdderMatch, organiserPresent: boolean, numberUnconfirmed: boolean): string {
  let who: string;
  switch (match) {
    case "phone":
      who = "the organiser (matched by phone)";
      break;
    case "lid":
      who = "the organiser (matched by WhatsApp id)";
      break;
    case "other-organiser-present":
      who = "someone else; the organiser IS in the group";
      break;
    case "unknown":
      who = `unknown; the organiser ${organiserPresent ? "IS" : "IS NOT"} in the group`;
      break;
    case "mismatch":
      who = "someone else; the organiser is NOT in the group";
      break;
  }
  return `Added by: ${who}${numberUnconfirmed ? " (organiser's WhatsApp number not confirmed)" : ""}`;
}

const LANG_LOOKS: Record<string, string> = { en: "English", tr: "Turkish" };
const LANG_CHOSEN: Record<string, string> = { en: "English", tr: "Türkçe" };

export interface OwnerApprovalDmInput {
  club: string;
  /** The connect code, which is the ref Kemal replies with. */
  code: string;
  organiserName: string | null;
  /** Digits. */
  organiserPhone: string;
  adderMatch: AdderMatch;
  organiserPresent: boolean;
  /** The connect DM's phone could not be read (bound on the LID alone). */
  numberUnconfirmed: boolean;
  groupSubject: string | null;
  memberCount: number;
  detectedLang: { lang: string; confident: boolean };
  clubLang: string | null;
  /** Group members who already play in an approved club, per club. */
  alsoIn: Array<{ orgName: string; count: number }>;
}

export function ownerApprovalDmText(p: OwnerApprovalDmInput): string {
  const lines: string[] = [];
  lines.push(`New club waiting: *${p.club}* (ref ${p.code})`);
  lines.push(
    `Organiser: ${p.organiserName?.trim() || "(no name)"}, ${formatPhoneForDisplay(p.organiserPhone)} (phone verified at sign-up)`,
  );
  lines.push(adderLine(p.adderMatch, p.organiserPresent, p.numberUnconfirmed));

  const group = p.groupSubject?.trim() ? `"${p.groupSubject.trim()}"` : "(no name)";
  const members =
    p.memberCount > 0 ? `${p.memberCount} ${p.memberCount === 1 ? "member" : "members"}` : "member list not read";
  const looks = p.detectedLang.confident
    ? `looks ${LANG_LOOKS[p.detectedLang.lang] ?? p.detectedLang.lang}`
    : "language unclear";
  const chose = LANG_CHOSEN[p.clubLang ?? "en"] ?? p.clubLang ?? "English";
  lines.push(`Group: ${group}, ${members}, ${looks} (club chose ${chose})`);

  const also = p.alsoIn.filter((a) => a.count > 0);
  if (also.length > 0) {
    const parts = also.map((a) => `${a.count} ${a.count === 1 ? "member plays" : "members play"} at ${a.orgName}`);
    lines.push(`Also in your other clubs: ${parts.join("; ")}`);
  }
  lines.push(`Reply APPROVE ${p.code} or REJECT ${p.code}, or use matchtime.ai/admin/clubs`);
  return lines.join("\n");
}
