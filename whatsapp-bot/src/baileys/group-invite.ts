/**
 * MatchTime JOINS A GROUP BY INVITE (2026-10-15).
 *
 * ── Why ─────────────────────────────────────────────────────────────
 * A new organiser tried to add MatchTime to his group and WhatsApp said
 * "Can't add MatchTime. You can invite them privately to join this group",
 * offering "Invite to group". WhatsApp refuses an add server-side when the
 * adder is not one of MatchTime's contacts (the only add that ever worked
 * was by the owner, who is). Pressing "Invite to group" DMs MatchTime a
 * `groupInviteMessage`; an organiser may also paste the group's
 * `chat.whatsapp.com/<code>` link. Nothing read either, so the setup died
 * there. The product must work for a customer setting up alone.
 *
 * ── What this does ──────────────────────────────────────────────────
 * For a DM carrying an invite, ask the server (`/api/whatsapp/group-invite`)
 * whether the sender is the organiser of an open, DM-verified connect
 * request, and join ONLY on a yes:
 *   private invite   `sock.groupAcceptInviteV4(key, invite)`. rc14 then
 *                    upserts a GROUP_PARTICIPANT_ADD stub in the group, with
 *                    the inviter as `participant` and our own `creds.me` as
 *                    the added participant, and `processMessage` turns that
 *                    into `group-participants.update` (action "add").
 *   pasted link      `sock.groupGetInviteInfo(code)` (an invalid, revoked or
 *                    expired link throws there), then
 *                    `sock.groupAcceptInvite(code)`, which returns the
 *                    group's JID and emits NOTHING locally.
 * Either way `deps.joined` then hands up ONE self-join with the inviter as
 * its author (the driver dedupes it against the participants update), and
 * the ordinary bot-added flow runs: roster, snapshot, POST bot-added, and
 * the server links the club (the inviter is the organiser, and is in the
 * group) and DMs the owner for approval. An invite join brings no shared
 * history; the flow already proceeds with none.
 *
 * ── Rules ───────────────────────────────────────────────────────────
 * Never twice: an invite, a link code and a group joined are remembered
 * (bounded, per process), and a second join for the same group is never
 * attempted while the first is in flight. A group MatchTime is already in
 * is left alone. An expired invite is ignored without asking anyone. A
 * stranger's link is never looked up at WhatsApp: the server is asked
 * first. A server that cannot be reached is not a yes. Nothing is ever
 * replied, and NOTHING about the sender, the code, the link or the group's
 * name is logged.
 */
import { normalizeMessageContent, type WAMessage, type proto } from "baileys";
import { bareLid, isGroupJid, phoneFromJid, type InboundKeyLike } from "./jid.js";
import { toNumber } from "./inbound.js";
import { maskJid } from "./log-mask.js";

const PREFIX = "[baileys][group-invite]";

/** How many invites, codes and groups are remembered. */
const MEMORY = 500;

/** `chat.whatsapp.com/<code>`, the host exactly, with or without a scheme. */
const LINK = /(?:^|[\s(<"'])(?:https?:\/\/)?chat\.whatsapp\.com\/(?:invite\/)?([A-Za-z0-9]{10,40})(?![A-Za-z0-9])/i;

export function inviteLinkCode(text: string | null | undefined): string | null {
  if (typeof text !== "string") return null;
  const m = LINK.exec(text);
  return m ? m[1] : null;
}

export function inviteMessageOf(m: WAMessage | null | undefined): proto.Message.IGroupInviteMessage | null {
  try {
    const content = normalizeMessageContent(m?.message);
    return content?.groupInviteMessage ?? null;
  } catch {
    return null;
  }
}

/** Who sent the invite, as the server's check takes it. `jid` stays on the Pi. */
export interface InviteSender {
  jid: string | null;
  phone?: string;
  senderLid?: string;
  senderAltPhone?: string;
}

export function inviteSenderOf(key: InboundKeyLike, resolvedPhone: string | null): InviteSender {
  const out: InviteSender = { jid: key.remoteJid ?? null };
  const phone = phoneFromJid(key.remoteJid) ?? phoneFromJid(key.remoteJidAlt) ?? resolvedPhone ?? null;
  if (phone) out.phone = phone;
  const lid = bareLid(key.remoteJid) ?? bareLid(key.remoteJidAlt);
  if (lid) out.senderLid = lid;
  const alt = phoneFromJid(key.remoteJidAlt);
  if (alt) out.senderAltPhone = alt;
  return out;
}

export type InviteKind = "invite-message" | "invite-link";

export interface GroupInviteDeps {
  /** The server's answer, or null when it could not be asked. */
  check(body: {
    phone?: string;
    senderLid?: string;
    senderAltPhone?: string;
    kind: InviteKind;
  }): Promise<{ accept: boolean; reason?: string } | null>;
  /** `sock.groupAcceptInviteV4`. Resolves to the group JID. */
  acceptV4(key: InboundKeyLike, invite: proto.Message.IGroupInviteMessage): Promise<string | undefined>;
  /** `sock.groupGetInviteInfo`. Throws for an invalid, revoked or expired link. */
  inviteInfo(code: string): Promise<{ id?: string | null }>;
  /** `sock.groupAcceptInvite`. Resolves to the group JID. */
  acceptLink(code: string): Promise<string | undefined>;
  /** Is MatchTime already a member of this group? */
  alreadyIn(groupJid: string): Promise<boolean>;
  /** Hand up the self-join, with the inviter as its author. */
  joined(groupJid: string, sender: InviteSender, kind: InviteKind): void;
  now(): number;
  log(line: string): void;
  error(line: string): void;
}

export type InviteOutcome =
  | "joined"
  | "refused"
  | "no-answer"
  | "expired"
  | "duplicate"
  | "already-in"
  | "invalid-link"
  | "failed"
  | "not-a-dm-invite";

export interface GroupInviteHandler {
  handleInviteMessage(m: WAMessage, sender: InviteSender): Promise<InviteOutcome>;
  handleInviteLink(code: string, sender: InviteSender): Promise<InviteOutcome>;
}

/** A remembered set that forgets its oldest entries past `MEMORY`. */
function boundedSet(): { has(k: string): boolean; add(k: string): void } {
  const s = new Set<string>();
  return {
    has: (k) => s.has(k),
    add(k) {
      s.delete(k);
      s.add(k);
      while (s.size > MEMORY) s.delete(s.values().next().value as string);
    },
  };
}

/** An error, for a log line: its text with anything id-shaped taken out. */
function safeError(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/\S*\d{6,}\S*/g, "<id>").replace(/\s+/g, " ").slice(0, 80) || "error";
}

export function createGroupInviteHandler(deps: GroupInviteDeps): GroupInviteHandler {
  const done = boundedSet();
  const joinedGroups = boundedSet();
  const inFlight = new Set<string>();

  const say = (kind: InviteKind, what: string) => deps.log(`${PREFIX} ${kind}: ${what}`);

  function senderBody(sender: InviteSender, kind: InviteKind) {
    const body: Parameters<GroupInviteDeps["check"]>[0] = { kind };
    if (sender.phone) body.phone = sender.phone;
    if (sender.senderLid) body.senderLid = sender.senderLid;
    if (sender.senderAltPhone) body.senderAltPhone = sender.senderAltPhone;
    return body;
  }

  /** The server's yes, or the outcome that ends the attempt. */
  async function ask(sender: InviteSender, kind: InviteKind): Promise<true | InviteOutcome> {
    let answer: { accept: boolean; reason?: string } | null;
    try {
      answer = await deps.check(senderBody(sender, kind));
    } catch {
      answer = null;
    }
    if (!answer) {
      say(kind, "ignored: the server could not be asked whether the sender is a verified organiser");
      return "no-answer";
    }
    if (answer.accept !== true) {
      const reason = typeof answer.reason === "string" && /^[a-z-]{1,40}$/.test(answer.reason) ? answer.reason : "no";
      say(kind, `ignored: the sender is not a verified organiser (${reason})`);
      return "refused";
    }
    return true;
  }

  async function join(
    kind: InviteKind,
    groupJid: string,
    sender: InviteSender,
    doJoin: () => Promise<string | undefined>,
    remember: string[],
  ): Promise<InviteOutcome> {
    if (inFlight.has(groupJid) || joinedGroups.has(groupJid)) {
      say(kind, "ignored: this group was already joined, or is being joined");
      return "duplicate";
    }
    inFlight.add(groupJid);
    try {
      const jid = (await doJoin()) || groupJid;
      for (const k of remember) done.add(k);
      joinedGroups.add(groupJid);
      if (jid !== groupJid) joinedGroups.add(jid);
      const group = isGroupJid(jid) ? jid : groupJid;
      say(kind, `joined ${maskJid(group)} for a verified organiser; the bot-added flow takes it from here`);
      deps.joined(group, sender, kind);
      return "joined";
    } catch (err) {
      deps.error(`${PREFIX} ${kind}: could not join: ${safeError(err)}`);
      return "failed";
    } finally {
      inFlight.delete(groupJid);
    }
  }

  return {
    async handleInviteMessage(m, sender) {
      const kind: InviteKind = "invite-message";
      const key = (m?.key ?? {}) as InboundKeyLike;
      const invite = inviteMessageOf(m);
      const chat = key.remoteJid ?? "";
      if (!invite || key.fromMe || !chat || isGroupJid(chat) || !isGroupJid(invite.groupJid)) {
        return "not-a-dm-invite";
      }
      const groupJid = invite.groupJid as string;
      const code = typeof invite.inviteCode === "string" ? invite.inviteCode : "";
      const ids = [`msg:${key.id ?? "?"}`, `v4:${groupJid}:${code}`];
      if (ids.some((k) => done.has(k)) || joinedGroups.has(groupJid) || inFlight.has(groupJid)) {
        say(kind, "ignored: this invite was already handled");
        return "duplicate";
      }
      const expiresSec = toNumber(invite.inviteExpiration);
      if (!code || expiresSec <= 0 || expiresSec * 1000 <= deps.now()) {
        for (const k of ids) done.add(k);
        say(kind, "ignored: the invite has expired or was already used");
        return "expired";
      }
      if (await safeAlreadyIn(groupJid)) {
        for (const k of ids) done.add(k);
        say(kind, "ignored: MatchTime is already in that group");
        return "already-in";
      }
      const yes = await ask(sender, kind);
      if (yes !== true) return yes;
      return join(kind, groupJid, sender, () => deps.acceptV4(key, invite), ids);
    },

    async handleInviteLink(code, sender) {
      const kind: InviteKind = "invite-link";
      const id = `link:${code}`;
      if (done.has(id) || inFlight.has(id)) {
        say(kind, "ignored: this link was already handled");
        return "duplicate";
      }
      const yes = await ask(sender, kind);
      if (yes !== true) return yes;
      inFlight.add(id);
      try {
        let groupJid: string | null = null;
        try {
          const info = await deps.inviteInfo(code);
          groupJid = isGroupJid(info?.id) ? (info.id as string) : null;
        } catch {
          groupJid = null;
        }
        if (!groupJid) {
          done.add(id);
          say(kind, "ignored: the link is invalid, revoked or expired");
          return "invalid-link";
        }
        if (joinedGroups.has(groupJid)) {
          done.add(id);
          say(kind, "ignored: this group was already joined, or is being joined");
          return "duplicate";
        }
        if (await safeAlreadyIn(groupJid)) {
          done.add(id);
          say(kind, "ignored: MatchTime is already in that group");
          return "already-in";
        }
        return join(kind, groupJid, sender, () => deps.acceptLink(code), [id]);
      } finally {
        inFlight.delete(id);
      }
    },
  };

  async function safeAlreadyIn(groupJid: string): Promise<boolean> {
    try {
      return (await deps.alreadyIn(groupJid)) === true;
    } catch {
      return false;
    }
  }
}
