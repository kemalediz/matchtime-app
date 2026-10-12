/**
 * DIRECT MESSAGES FROM THE ORGANISER OF A CLUB THAT IS SETTING UP
 * (go-live slice S4, 2026-10-12; plan 2.4 and 2.5, owner decisions 4, 5
 * and 8). Deterministic end to end: nothing here calls a model.
 *
 * Two handlers, both called from `api/whatsapp/dm-reply`:
 *
 *   `handleGoDm`         "GO" (GO LIVE, BAŞLA, BASLA): take the club live.
 *                        Runs near the top of the route, before every
 *                        other handler, and outside the self-join flag.
 *   `handleSettingUpDm`  anything else from somebody the setting-up rail
 *                        has stopped: deterministic help is answered, and
 *                        an owner or admin is told, EVERY time, that the
 *                        message was not recognised and how to go live.
 *
 * WHO. Only a CURRENT owner or admin (`leftAt` null) of the club, known by
 * phone or by a LID the server itself stored (`resolveSenderUserIds`).
 * Never by the WhatsApp display name, which the sender controls. A plain
 * member gets silence, as before.
 *
 * WHERE THE REPLIES GO. The platform channel (`queuePlatformDm`, purpose
 * "setup-reply"): the club's own channel is not dispatched while its bot
 * is off. Sent at once, at any hour: each is the answer to a message the
 * organiser has just sent.
 *
 * REPLAYS. The Pi may deliver the same WhatsApp message twice. Each
 * handler claims a key for the message before it acts, so the second
 * delivery does nothing and sends nothing.
 */
import { db } from "./db";
import { resolveSenderUserIds } from "./admin-group-link";
import { appUrl, buildAdminLink } from "./admin-link";
import {
  GO_ALREADY_LIVE_WINDOW_MS,
  SETTING_UP_CLUB_WHERE,
  SETUP_STAGE_SELECT,
  goLiveClub,
  isClubSettingUp,
  isGoCommand,
  liveByUser,
  liveByWhatsapp,
  wentLiveSinceWhere,
  type GoLiveResult,
} from "./club-setup";
import { t } from "./i18n/t";
import { normalisePhone } from "./phone";
import { PlatformDmRefused, queuePlatformDm } from "./platform-jobs";

const ADMIN_ROLES = { in: ["OWNER", "ADMIN"] as Array<"OWNER" | "ADMIN"> };

/** The platform purpose of every reply here. */
export const SETUP_REPLY_PURPOSE = "setup-reply" as const;

/** The settings page: where the Go live button is. */
export const GO_LIVE_SETTINGS_PATH = "/admin/settings";

/** How long the signed-in settings link in a reply works (as the setup DM's). */
const LINK_TTL_SECONDS = 7 * 24 * 60 * 60;

const CLAIM_KIND = "setup-go";
const goClaimKey = (waMessageId: string) => `setup-go-msg:${waMessageId}`;
const dmClaimKey = (waMessageId: string) => `setup-dm-msg:${waMessageId}`;

/** First writer wins. False: this WhatsApp message was already handled. */
async function claim(key: string): Promise<boolean> {
  try {
    await db.sentNotification.create({ data: { key, kind: CLAIM_KIND } });
    return true;
  } catch {
    return false;
  }
}

const release = (key: string) => db.sentNotification.deleteMany({ where: { key } }).catch(() => {});

function envelopePhone(raw: string | null | undefined): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const s = raw.trim();
  return normalisePhone(s.startsWith("+") ? s : `+${s.replace(/\D/g, "")}`);
}

/** Queue one reply. Never throws: a reply that cannot be sent must not
 *  undo what was done (a club that went live stays live). */
async function reply(phone: string | null, text: string, refId: string): Promise<boolean> {
  if (!phone) {
    console.error(`[setup-go] no number to reply to (${refId}); nothing sent`);
    return false;
  }
  try {
    await queuePlatformDm({ phone, text, purpose: SETUP_REPLY_PURPOSE, refId });
    return true;
  } catch (err) {
    if (err instanceof PlatformDmRefused) console.error(`[setup-go] reply not queued (${refId}): ${err.reason}`);
    else console.error(`[setup-go] reply not queued (${refId}):`, err);
    return false;
  }
}

/** The reply to GO for each outcome, in the club's language. Null: say nothing. */
export function goReplyText(result: GoLiveResult): string | null {
  if (result.outcome === "not-setting-up") return null;
  const s = t(result.language);
  switch (result.outcome) {
    case "went-live":
      return s.sj_go_done({ group: result.group });
    case "still-reading":
      return s.sj_go_still_reading;
    case "removed-from-group":
      return s.sj_go_removed({ group: result.group });
    case "already-live":
      return s.sj_go_already_live({ club: result.club });
  }
}

export type GoDmOutcome =
  | { handled: "setup-go"; outcome: GoLiveResult["outcome"] | "more-than-one"; orgId: string | null }
  | { handled: "setup-go-duplicate" };

/**
 * "GO" by DM. Returns null, having changed and sent nothing, unless the
 * WHOLE message is the command AND the sender is a current owner or admin
 * of a club that is setting up (or that went live in the last ten
 * minutes, so a second admin is told "already live"). The text is checked
 * first, so no other DM costs a query here.
 */
export async function handleGoDm(input: {
  text: string;
  phone?: string | null;
  senderAltPhone?: string | null;
  senderLid?: string | null;
  waMessageId: string;
  now?: Date;
  /** SETUP_LEARNING_ENABLED as the route reads it for this request. */
  learningEnabled?: boolean;
}): Promise<GoDmOutcome | null> {
  if (!isGoCommand(input.text)) return null;
  const userIds = await resolveSenderUserIds({ phones: [input.phone, input.senderAltPhone], lid: input.senderLid ?? null });
  if (userIds.length === 0) return null;

  const now = input.now ?? new Date();
  const rows = await db.membership.findMany({
    where: {
      userId: { in: userIds },
      leftAt: null,
      role: ADMIN_ROLES,
      org: { OR: [SETTING_UP_CLUB_WHERE, wentLiveSinceWhere(new Date(now.getTime() - GO_ALREADY_LIVE_WINDOW_MS))] },
    },
    select: {
      userId: true,
      orgId: true,
      user: { select: { phoneNumber: true } },
      org: { select: { id: true, name: true, language: true, liveAt: true, ...SETUP_STAGE_SELECT } },
    },
    orderBy: { createdAt: "asc" },
  });
  // One row per club (a sender who resolves to two accounts in one club).
  const clubs = rows.filter((r, i) => rows.findIndex((x) => x.orgId === r.orgId) === i);
  if (clubs.length === 0) return null;

  const key = goClaimKey(input.waMessageId);
  if (!(await claim(key))) return { handled: "setup-go-duplicate" };

  const settingUp = clubs.filter((c) => isClubSettingUp(c.org));
  const sender = settingUp[0] ?? clubs[0];
  const replyTo = (sender.user.phoneNumber ? normalisePhone(sender.user.phoneNumber) : null) ?? envelopePhone(input.phone);
  const ref = (orgId: string) => `${orgId}:go:${input.waMessageId}`;

  try {
    if (settingUp.length > 1) {
      // GO cannot say which club. None goes live.
      await reply(replyTo, t(sender.org.language).sj_go_many, ref(sender.orgId));
      return { handled: "setup-go", outcome: "more-than-one", orgId: null };
    }
    if (settingUp.length === 0) {
      // A club this person runs went live a moment ago (another admin, or
      // the button): the most recent one answers.
      const latest = [...clubs].sort((a, b) => (b.org.liveAt?.getTime() ?? 0) - (a.org.liveAt?.getTime() ?? 0))[0];
      await reply(replyTo, t(latest.org.language).sj_go_already_live({ club: latest.org.name }), ref(latest.orgId));
      return { handled: "setup-go", outcome: "already-live", orgId: latest.orgId };
    }

    const by = replyTo ? liveByWhatsapp(replyTo) : liveByUser(sender.userId);
    const result = await goLiveClub(sender.orgId, by, now, { learningEnabled: input.learningEnabled });
    const text = goReplyText(result);
    if (text) await reply(replyTo, text, ref(sender.orgId));
    return { handled: "setup-go", outcome: result.outcome, orgId: sender.orgId };
  } catch (err) {
    // Nothing was committed (the go-live is one transaction): let a Pi
    // retry of this message try again.
    await release(key);
    throw err;
  }
}

export type SettingUpDmOutcome =
  | { ignored: "club-setting-up" }
  | { handled: "setup-dm-duplicate" }
  | { handled: "setup-not-recognised"; orgIds: string[] }
  | import("./dm-help").DmHelpOutcome;

/**
 * A DM from somebody the setting-up rail has stopped (every club MatchTime
 * serves for them is still setting up), which was NOT a GO.
 *
 *   - Not a verified current owner or admin of such a club: silence, and
 *     nothing queued (a plain member, or a sender known only by display
 *     name).
 *   - A help request: the same deterministic help as ever, delivered on
 *     the platform channel so it actually arrives.
 *   - Anything else: "not recognised", with how to go live and that
 *     club's settings link. Every time; the only limit is one reply per
 *     WhatsApp message.
 */
export async function handleSettingUpDm(input: {
  userId: string;
  text: string;
  phone?: string | null;
  senderAltPhone?: string | null;
  senderLid?: string | null;
  waMessageId: string;
  isHelpRequest: boolean;
}): Promise<SettingUpDmOutcome> {
  const silent = { ignored: "club-setting-up" } as const;
  const verified = await resolveSenderUserIds({ phones: [input.phone, input.senderAltPhone], lid: input.senderLid ?? null });
  if (!verified.includes(input.userId)) return silent;

  const runs = await db.membership.findMany({
    where: { userId: input.userId, leftAt: null, role: ADMIN_ROLES, org: SETTING_UP_CLUB_WHERE },
    select: { orgId: true, org: { select: { id: true, name: true, language: true } } },
    orderBy: { createdAt: "asc" },
  });
  if (runs.length === 0) return silent;

  if (!(await claim(dmClaimKey(input.waMessageId)))) return { handled: "setup-dm-duplicate" };

  if (input.isHelpRequest) {
    const { handleDmHelp } = await import("./dm-help");
    const help = await handleDmHelp({ userId: input.userId, text: input.text, envelopePhone: input.phone, deliver: "platform" }).catch(
      (err) => {
        console.error(`[setup-go] help for ${input.userId} could not be queued:`, err);
        return null;
      },
    );
    if (help) return help;
  }

  const account = await db.user.findUnique({ where: { id: input.userId }, select: { phoneNumber: true } });
  const accountPhone = account?.phoneNumber ? normalisePhone(account.phoneNumber) : null;
  const replyTo = accountPhone ?? envelopePhone(input.phone);
  // A signed-in link only ever goes to the account's own number.
  const link = async (orgId: string): Promise<string> => {
    if (!accountPhone) return appUrl(GO_LIVE_SETTINGS_PATH);
    try {
      return await buildAdminLink({ userId: input.userId, orgId, nextPath: GO_LIVE_SETTINGS_PATH, ttlSeconds: LINK_TTL_SECONDS });
    } catch (err) {
      console.error(`[setup-go] signed-in settings link for ${orgId} failed; sending the plain address:`, err);
      return appUrl(GO_LIVE_SETTINGS_PATH);
    }
  };
  const s = t(runs[0].org.language);
  const text =
    runs.length === 1
      ? s.sj_go_not_recognised({ club: runs[0].org.name, url: await link(runs[0].orgId) })
      : s.sj_go_not_recognised_many({
          clubs: await Promise.all(runs.map(async (r) => ({ club: r.org.name, url: await link(r.orgId) }))),
        });
  await reply(replyTo, text, `${runs[0].orgId}:not-recognised:${input.waMessageId}`);
  return { handled: "setup-not-recognised", orgIds: runs.map((r) => r.orgId) };
}
