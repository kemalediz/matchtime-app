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

  if (!ev.discovered) {
    if (ev.addedByPhone) {
      const byPhone = open.find((c) => c.phone === ev.addedByPhone);
      if (byPhone) return { link: true, connectId: byPhone.id, adderMatch: "phone", organiserPresent: true };
    }
    if (ev.addedByLid) {
      const byLid = open.find((c) => c.status === "dm_verified" && c.dmLid === ev.addedByLid);
      if (byLid) return { link: true, connectId: byLid.id, adderMatch: "lid", organiserPresent: true };
    }
  }

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
