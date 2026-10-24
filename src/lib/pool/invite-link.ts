/**
 * WHERE A CLUB'S GROUP INVITE LINK COMES FROM (local player pool L8,
 * 2026-10-24). PURE, client-safe.
 *
 * Approved spec, "Joining the group": only once the guest and the club have
 * both said yes does the guest get the group's invite link. Decision log #5
 * and the spec: MatchTime, as an admin of the group, makes the link itself
 * (preferred); a club that prefers not to make MatchTime an admin pastes its
 * link once, on the settings page.
 *
 *   A  "bot"     MatchTime is an admin of the players' group (the Pi's
 *                postability report, `GroupPostState.botIsAdmin`) AND the
 *                Pi job that reads the group's invite code is switched on
 *                (`GROUP_INVITE_CODE_JOBS`, set only after the Pi build
 *                that knows the job is deployed). The Pi reads the group's
 *                CURRENT invite code (Baileys `groupInviteCode`), never a
 *                revoke: a revoke would break every link the organisers
 *                already shared. A pasted link, if any, is the fallback
 *                when the Pi cannot read it.
 *   B  "pasted"  the link an organiser pasted on the settings page.
 *   none         neither: an organiser is told how (the guest card and the
 *                organisers' notice).
 *
 * The link is stored as `https://chat.whatsapp.com/<code>` and nothing
 * else: any scheme, case, trailing query or "invite/" path is dropped, and
 * a host that only CONTAINS chat.whatsapp.com is refused.
 */

export const WHATSAPP_INVITE_HOST = "chat.whatsapp.com";
/** Where an organiser sets up the group link: the settings card's anchor. */
export const INVITE_LINK_SETTINGS_PATH = "/admin/settings#group-invite-link";
export const GROUP_INVITE_CODE_JOBS_ENV = "GROUP_INVITE_CODE_JOBS";

/** A WhatsApp group invite code, as the bot's own invite reader takes it. */
const CODE_RE = /^[A-Za-z0-9]{10,40}$/;
const LINK_RE = /^(?:https?:\/\/)?chat\.whatsapp\.com\/(?:invite\/)?([A-Za-z0-9]{10,40})\/?(?:\?[^\s/]*)?$/i;

export type ParsedInviteLink = { ok: true; link: string | null } | { ok: false; reason: "not-a-group-link" };

export function parseGroupInviteLink(input: unknown, opts: { allowEmpty?: boolean } = {}): ParsedInviteLink {
  const v = typeof input === "string" ? input.trim() : "";
  if (!v) return opts.allowEmpty ? { ok: true, link: null } : { ok: false, reason: "not-a-group-link" };
  const hit = LINK_RE.exec(v);
  if (!hit) return { ok: false, reason: "not-a-group-link" };
  return { ok: true, link: `https://${WHATSAPP_INVITE_HOST}/${hit[1]}` };
}

/** The link for a code the Pi read; null for anything that is not a code. */
export function groupInviteLinkFromCode(code: unknown): string | null {
  if (typeof code !== "string" || !CODE_RE.test(code)) return null;
  return `https://${WHATSAPP_INVITE_HOST}/${code}`;
}

type Env = Record<string, string | undefined>;

/** Is the Pi's invite-code job switched on (only after the Pi is deployed)? */
export function isGroupInviteCodeJobsOn(env: Env = process.env): boolean {
  return /^(1|true|on|yes)$/i.test((env[GROUP_INVITE_CODE_JOBS_ENV] ?? "").trim());
}

export type InviteLinkSource =
  | { kind: "bot"; groupId: string; fallback: string | null }
  | { kind: "pasted"; link: string }
  | { kind: "none" };

export function inviteLinkSource(c: { groupId: string | null; botIsAdmin: boolean; codeJobsOn: boolean; pastedLink: string | null }): InviteLinkSource {
  if (c.groupId && c.botIsAdmin && c.codeJobsOn) return { kind: "bot", groupId: c.groupId, fallback: c.pastedLink };
  if (c.pastedLink) return { kind: "pasted", link: c.pastedLink };
  return { kind: "none" };
}
