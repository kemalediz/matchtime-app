/**
 * THE ADMIN CHANNEL, pure rules (slice 2a, 2026-09-30).
 * Plan: MDs/friday-group-features-plan-2026-09-30.md, sections 2.2 to 2.4.
 *
 * Three questions, answered without a database or a model:
 *   - who an admin-only notice goes to (`resolveAdminNoticeTargets`);
 *   - whether MatchTime being added to a group is an admin group waiting
 *     for its code rather than a new club (`isAdminGroupCandidate`);
 *   - the link code: making one, and reading "@Match Time admin group
 *     CODE" (`generateAdminGroupLinkCode`, `parseAdminGroupLinkMessage`).
 *
 * The DB half is `admin-channel.ts` (sending) and `admin-group-link.ts`
 * (linking). A copy of the link-command shape lives on the Pi
 * (whatsapp-bot/src/admin-group.ts), so only a message shaped like the
 * command ever leaves a silent group.
 */
import { randomInt } from "node:crypto";

export const ADMIN_CHANNEL_MODES = ["one-person", "admin-group", "each-admin"] as const;
export type AdminChannelMode = (typeof ADMIN_CHANNEL_MODES)[number];

/**
 * A stored mode, read defensively. Anything unknown reads as "each-admin",
 * today's behaviour: the failure to avoid is a club silently losing its
 * notices, and every admin getting one is the safe side of that.
 */
export function normaliseAdminChannelMode(value: unknown): AdminChannelMode {
  return (ADMIN_CHANNEL_MODES as readonly string[]).includes(value as string)
    ? (value as AdminChannelMode)
    : "each-admin";
}

/** An OWNER or ADMIN with an active membership, phone or not. */
export interface ChannelAdmin {
  id: string;
  name: string | null;
  role: "OWNER" | "ADMIN";
  phoneNumber: string | null;
}

export interface AdminChannelConfig {
  mode: AdminChannelMode;
  /** one-person: who. NULL = the owner. */
  channelUserId: string | null;
  /** The linked admin WhatsApp group, if any. */
  adminGroupId: string | null;
}

export type DmRecipient = { id: string; name: string | null; phoneNumber: string };

export type AdminNoticeTarget =
  | {
      kind: "dm";
      users: DmRecipient[];
      /** How the recipients were chosen. The two fallbacks are logged. */
      via: "each-admin" | "one-person" | "owner-fallback" | "each-admin-fallback";
    }
  | { kind: "group"; groupId: string };

const withPhone = (a: ChannelAdmin): a is ChannelAdmin & { phoneNumber: string } => !!a.phoneNumber;
const dm = (a: ChannelAdmin & { phoneNumber: string }): DmRecipient => ({ id: a.id, name: a.name, phoneNumber: a.phoneNumber });

/**
 * Who an admin-only notice goes to.
 *
 *   each-admin   every owner and admin with a phone, in the order given
 *                (exactly today's `findOrgAdminsWithPhone`);
 *   one-person   the chosen admin if still an admin with a phone, else the
 *                owner, else each admin;
 *   admin-group  the linked group, but only when the Pi polling right now
 *                has said it can send there; otherwise the owner, else each
 *                admin. A rolled-back Pi therefore never swallows a notice.
 */
export function resolveAdminNoticeTargets(
  cfg: AdminChannelConfig,
  admins: readonly ChannelAdmin[],
  piCaps: { adminGroup: boolean },
): AdminNoticeTarget {
  const reachable = admins.filter(withPhone);
  const everyAdmin = (via: "each-admin" | "each-admin-fallback"): AdminNoticeTarget => ({
    kind: "dm",
    users: reachable.map(dm),
    via,
  });
  const theOwner = (via: "one-person" | "owner-fallback"): AdminNoticeTarget => {
    const owner = reachable.find((a) => a.role === "OWNER");
    return owner ? { kind: "dm", users: [dm(owner)], via } : everyAdmin("each-admin-fallback");
  };

  switch (cfg.mode) {
    case "each-admin":
      return everyAdmin("each-admin");
    case "one-person": {
      if (!cfg.channelUserId) return theOwner("one-person");
      const chosen = reachable.find((a) => a.id === cfg.channelUserId);
      return chosen ? { kind: "dm", users: [dm(chosen)], via: "one-person" } : theOwner("owner-fallback");
    }
    case "admin-group":
      if (cfg.adminGroupId && piCaps.adminGroup) return { kind: "group", groupId: cfg.adminGroupId };
      return theOwner("owner-fallback");
  }
}

// ── The HQ group: an admin group waiting for its code (2.4) ─────────────

/**
 * Is MatchTime being added to this group an admin group candidate? True
 * when the adder is an owner or admin of an approved club, or when an
 * unexpired link code exists for an approved club and one of the group's
 * members is an owner or admin of THAT club (an adder whose LID we cannot
 * resolve yet). Anything else is a new club and follows today's path.
 */
export function isAdminGroupCandidate(input: {
  adderIsApprovedClubAdmin: boolean;
  /** Link codes of approved clubs, with their expiry. */
  openCodes: ReadonlyArray<{ orgId: string; expiresAt: Date | null }>;
  /** Approved clubs one of the group's members is an owner or admin of. */
  participantAdminOrgIds: readonly string[];
  now: Date;
}): boolean {
  if (input.adderIsApprovedClubAdmin) return true;
  const withAdminHere = new Set(input.participantAdminOrgIds);
  return input.openCodes.some(
    (c) => c.expiresAt !== null && c.expiresAt.getTime() > input.now.getTime() && withAdminHere.has(c.orgId),
  );
}

// ── The link code (2.3) ─────────────────────────────────────────────────

/** No 0/O, 1/I/L: a code read off a screen and typed on a phone. */
export const ADMIN_GROUP_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const ADMIN_GROUP_CODE_LENGTH = 6;
/** How long a code shown on the settings page stays valid. */
export const ADMIN_GROUP_CODE_TTL_MS = 48 * 60 * 60 * 1000;

export function generateAdminGroupLinkCode(rand: (max: number) => number = (max) => randomInt(max)): string {
  let out = "";
  for (let i = 0; i < ADMIN_GROUP_CODE_LENGTH; i++) {
    out += ADMIN_GROUP_CODE_ALPHABET[rand(ADMIN_GROUP_CODE_ALPHABET.length)];
  }
  return out;
}

/** "admin group" or "yönetici grubu" (typed with or without the accents),
 *  then an optional colon or dash, then exactly six letters or digits. */
const LINK_COMMAND =
  /(?<![\p{L}\p{N}])(?:admin\s+group|y[oö]netici\s+grub[uü])\s*[:\-]?\s*([a-z0-9]{6})(?![\p{L}\p{N}])/u;

/**
 * The code in "@Match Time admin group K7P3QX", upper-cased, or null.
 *
 * MatchTime must be addressed: a real tag (`botMentioned`, which only the
 * Pi can tell) or the words "Match Time" typed. The code is read as any
 * six letters or digits, not only the alphabet above, so a typo reaches the
 * server and an admin is told the code is wrong instead of hearing nothing.
 */
export function parseAdminGroupLinkMessage(text: string, opts: { botMentioned?: boolean } = {}): string | null {
  if (typeof text !== "string" || !text.trim()) return null;
  const folded = text.toLocaleLowerCase("tr").replace(/ı/g, "i");
  const addressed = opts.botMentioned === true || /match\s*time/.test(folded);
  if (!addressed) return null;
  const m = LINK_COMMAND.exec(folded);
  return m ? m[1].toUpperCase() : null;
}

// ── What the Pi can do (2.5) ────────────────────────────────────────────

/**
 * Sent by the Pi on every due-posts poll: a comma list of capabilities.
 * A Pi built with slice 2a sends "admin-group": it knows the admin groups
 * and can post in them. The server targets a group only when it sees it,
 * so an older (or rolled-back) Pi is never handed a post it would drop.
 * The Pi reads the same literals (whatsapp-bot/src/api.ts).
 */
export const PI_CAPS_HEADER = "x-mt-pi-caps";
export const PI_CAP_ADMIN_GROUP = "admin-group";

export interface PiCaps {
  adminGroup: boolean;
}

export function parsePiCaps(header: string | null | undefined): PiCaps {
  const caps = new Set(
    (header ?? "")
      .split(",")
      .map((c) => c.trim().toLowerCase())
      .filter(Boolean),
  );
  return { adminGroup: caps.has(PI_CAP_ADMIN_GROUP) };
}

/**
 * Admin-group posts go out 08:00 to 21:59 London, like the bench offers;
 * anything due overnight waits for the morning. Every post is claimed once
 * by its key, so waiting delays it and never doubles it.
 */
export const ADMIN_GROUP_POST_FROM_HOUR = 8;
export const ADMIN_GROUP_POST_TO_HOUR = 22;

export function isAdminGroupPostHour(now: Date): boolean {
  const h = Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "numeric", hour12: false })
      .formatToParts(now)
      .find((p) => p.type === "hour")?.value ?? "0",
  );
  return h >= ADMIN_GROUP_POST_FROM_HOUR && h < ADMIN_GROUP_POST_TO_HOUR;
}
