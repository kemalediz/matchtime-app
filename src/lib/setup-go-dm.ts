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
 *                        an owner or admin is told that the message was
 *                        not recognised and how to go live.
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
 * THE CAP (PR #234 review, fix 1). The Pi sends ONE DM a minute for the
 * whole platform and serves this channel before any club's, so every
 * reply here delays a live club's bench offer or pay link by a minute. An
 * organiser is answered every time in normal use; a chatty one, or a
 * WhatsApp Business auto-reply that answers our answer, is not allowed to
 * queue without limit: at most `SETUP_REPLY_CAPS.perHour` replies to one
 * number in any hour and `perDay` in any day, counted from the
 * "setup-reply" jobs already queued or sent to it. Over the cap: silence.
 * The one reply never held back is "Done", when a club has just gone live.
 *
 * REPLAYS. The Pi may deliver the same WhatsApp message twice. Each
 * handler claims a key for the message before it acts, so the second
 * delivery does nothing and sends nothing. If the work then fails, the
 * claim is released, so the Pi's retry is a real retry.
 */
import { db } from "./db";
import { resolveSenderUserIds } from "./admin-group-link";
import { appUrl } from "./admin-link";
import {
  SETTING_UP_CLUB_WHERE,
  SETUP_STAGE_SELECT,
  WENT_LIVE_CLUB_WHERE,
  goLiveClub,
  isClubSettingUp,
  isGoCommand,
  liveByUser,
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

/** Replies to one number, in any rolling hour and any rolling day. */
export const SETUP_REPLY_CAPS = { perHour: 5, perDay: 15 } as const;

const HOUR_MS = 60 * 60 * 1000;

const CLAIM_KIND = "setup-go";
const goClaimKey = (waMessageId: string) => `setup-go-msg:${waMessageId}`;
const dmClaimKey = (waMessageId: string) => `setup-dm-msg:${waMessageId}`;

/**
 * First writer wins. False: this WhatsApp message was already handled.
 * ONLY a unique violation means that. Any other database error is thrown,
 * so the route fails and the Pi sends the message again, instead of a
 * dropped connection being read as "seen before" and the DM being
 * swallowed (PR #234 review, fix 5).
 */
async function claim(key: string): Promise<boolean> {
  try {
    await db.sentNotification.create({ data: { key, kind: CLAIM_KIND } });
    return true;
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === "P2002") return false;
    throw err;
  }
}

const release = (key: string) => db.sentNotification.deleteMany({ where: { key } }).catch(() => {});

function envelopePhone(raw: string | null | undefined): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const s = raw.trim();
  return normalisePhone(s.startsWith("+") ? s : `+${s.replace(/\D/g, "")}`);
}

/** Has this number had its share of replies? See THE CAP in the header. */
export async function setupReplyCapReached(phone: string, now: Date): Promise<boolean> {
  const counted = {
    kind: "dm",
    phone: phone.replace(/\D/g, ""),
    purpose: SETUP_REPLY_PURPOSE,
    // A reply that failed to send never reached anybody: not counted.
    status: { in: ["queued", "claimed", "sent", "unconfirmed"] },
  };
  const since = (ms: number) => ({ gte: new Date(now.getTime() - ms) });
  const day = await db.platformJob.count({ where: { ...counted, createdAt: since(24 * HOUR_MS) } });
  if (day >= SETUP_REPLY_CAPS.perDay) return true;
  if (day < SETUP_REPLY_CAPS.perHour) return false;
  return (await db.platformJob.count({ where: { ...counted, createdAt: since(HOUR_MS) } })) >= SETUP_REPLY_CAPS.perHour;
}

type ReplyResult = "queued" | "capped" | "no-number" | "refused" | "failed";

/**
 * Queue one reply. `capped: true` holds it back once the number has had
 * its share. `strict: true` lets a database failure throw (the caller
 * releases its claim and the Pi retries); otherwise nothing is thrown,
 * because a reply that cannot be sent must not undo a club that went live.
 */
async function reply(args: {
  phone: string | null;
  text: string;
  refId: string;
  now: Date;
  capped: boolean;
  strict?: boolean;
}): Promise<ReplyResult> {
  if (!args.phone) {
    console.error(`[setup-go] no number to reply to (${args.refId}); nothing sent`);
    return "no-number";
  }
  try {
    if (args.capped && (await setupReplyCapReached(args.phone, args.now))) {
      console.log(`[setup-go] reply cap reached (${args.refId}); nothing sent`);
      return "capped";
    }
    await queuePlatformDm({ phone: args.phone, text: args.text, purpose: SETUP_REPLY_PURPOSE, refId: args.refId });
    return "queued";
  } catch (err) {
    if (err instanceof PlatformDmRefused) {
      console.error(`[setup-go] reply not queued (${args.refId}): ${err.reason}`);
      return "refused";
    }
    if (args.strict) throw err;
    console.error(`[setup-go] reply not queued (${args.refId}):`, err);
    return "failed";
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
    case "billing-paused":
      return s.sj_go_paused({ club: result.club, url: appUrl(GO_LIVE_SETTINGS_PATH) });
  }
}

export type GoDmOutcome =
  | { handled: "setup-go"; outcome: GoLiveResult["outcome"] | "more-than-one"; orgId: string | null }
  | { handled: "setup-go-duplicate" };

/**
 * "GO" by DM. Returns null, having changed and sent nothing, unless the
 * WHOLE message is the command AND the sender is a current owner or admin
 * of a club that is setting up, or of one that has been through the hold
 * and is live (they are told "already live", however long ago that was).
 * A club that was never held does not count: GO from its admin is an
 * ordinary DM and falls through. The text is checked first, so no other
 * DM costs a query here.
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
  /** BILLING_ENABLED as the route reads it for this request. */
  billingEnabled?: boolean;
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
      org: { OR: [SETTING_UP_CLUB_WHERE, WENT_LIVE_CLUB_WHERE] },
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
  const phone = (sender.user.phoneNumber ? normalisePhone(sender.user.phoneNumber) : null) ?? envelopePhone(input.phone);
  const say = (orgId: string, text: string, capped: boolean) =>
    reply({ phone, text, refId: `${orgId}:go:${input.waMessageId}`, now, capped });

  try {
    if (settingUp.length > 1) {
      // GO cannot say which club. None goes live.
      await say(sender.orgId, t(sender.org.language).sj_go_many, true);
      return { handled: "setup-go", outcome: "more-than-one", orgId: null };
    }
    if (settingUp.length === 0) {
      // Every club this person runs that was held is live already: the
      // one that went live most recently answers.
      const latest = [...clubs].sort((a, b) => (b.org.liveAt?.getTime() ?? 0) - (a.org.liveAt?.getTime() ?? 0))[0];
      await say(latest.orgId, t(latest.org.language).sj_go_already_live({ club: latest.org.name }), true);
      return { handled: "setup-go", outcome: "already-live", orgId: latest.orgId };
    }

    // The sender has been matched to a user: that user is who took the
    // club live. The number stays out of the record.
    const result = await goLiveClub(sender.orgId, liveByUser(sender.userId), now, {
      learningEnabled: input.learningEnabled,
      billingEnabled: input.billingEnabled,
    });
    const text = goReplyText(result);
    // "Done" is said whatever the cap says: it happens once per club.
    if (text) await say(sender.orgId, text, result.outcome !== "went-live");
    return { handled: "setup-go", outcome: result.outcome, orgId: sender.orgId };
  } catch (err) {
    // Nothing was committed (the go-live is one transaction, and a failed
    // reply after it does not throw): let the Pi's retry try again.
    await release(key);
    throw err;
  }
}

export type SettingUpDmOutcome =
  | { ignored: "club-setting-up" }
  | { ignored: "setup-reply-capped" }
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
 *   - Anything else: "not recognised", with how to go live and the plain
 *     address of the settings page (no signed-in link is minted for a
 *     message we did not understand).
 * One reply per WhatsApp message, and no more than the cap allows.
 */
export async function handleSettingUpDm(input: {
  userId: string;
  text: string;
  phone?: string | null;
  senderAltPhone?: string | null;
  senderLid?: string | null;
  waMessageId: string;
  isHelpRequest: boolean;
  now?: Date;
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

  const key = dmClaimKey(input.waMessageId);
  if (!(await claim(key))) return { handled: "setup-dm-duplicate" };

  try {
    const now = input.now ?? new Date();
    const account = await db.user.findUnique({ where: { id: input.userId }, select: { phoneNumber: true } });
    const phone = (account?.phoneNumber ? normalisePhone(account.phoneNumber) : null) ?? envelopePhone(input.phone);
    const orgIds = runs.map((r) => r.orgId);

    if (input.isHelpRequest) {
      // Help queues its own job, so the cap is checked here, for whichever
      // number it will answer (the envelope's, else the account's).
      const helpPhone = envelopePhone(input.phone) ?? phone;
      if (helpPhone && (await setupReplyCapReached(helpPhone, now))) {
        console.log(`[setup-go] reply cap reached for ${input.userId} (help, ${input.waMessageId}); nothing sent`);
        return { ignored: "setup-reply-capped" };
      }
      const { handleDmHelp } = await import("./dm-help");
      try {
        const help = await handleDmHelp({ userId: input.userId, text: input.text, envelopePhone: input.phone, deliver: "platform" });
        if (help) return help;
      } catch (err) {
        if (!(err instanceof PlatformDmRefused)) throw err;
        console.error(`[setup-go] help for ${input.userId} not queued: ${err.reason}`);
        return silent;
      }
    }

    const s = t(runs[0].org.language);
    const url = appUrl(GO_LIVE_SETTINGS_PATH);
    const text = runs.length === 1 ? s.sj_go_not_recognised({ club: runs[0].org.name, url }) : s.sj_go_not_recognised_many({ url });
    const sent = await reply({
      phone,
      text,
      refId: `${runs[0].orgId}:not-recognised:${input.waMessageId}`,
      now,
      capped: true,
      strict: true,
    });
    if (sent === "capped") return { ignored: "setup-reply-capped" };
    return { handled: "setup-not-recognised", orgIds };
  } catch (err) {
    // The reply was not queued: release the claim so the Pi's retry of
    // this message is answered, not read as a duplicate.
    await release(key);
    throw err;
  }
}
