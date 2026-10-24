/**
 * THE /play CONFIRM DM HANDLER (slice L2, 2026-10-24): the thin I/O half of
 * `confirm-rules.ts`. Runs at the TOP of /api/whatsapp/dm-reply, before the
 * sender lookup (a stranger has no User yet) and before every model path.
 * DETERMINISTIC: no model call anywhere in here.
 *
 * Returns null, and the DM goes on to today's handling untouched, when the
 * message carries no code, or a code that names no sign-up in words that
 * are not our confirm message ("what's the code then?"). Otherwise the DM
 * is this handler's, whatever it decides, and nothing below reads it.
 *
 * Confirming, in ONE transaction with a compare-and-set on the waiting row:
 *   - the User is found by the number that sent it, or created (a member
 *     who signs up keeps his one identity); the number that reached us is
 *     the one recorded, whoever's code it was (plan 3.1, point 4);
 *   - a stopped profile of his is replaced by the new sign-up (a fresh
 *     consent; deleting a profile already removed it);
 *   - the profile turns "active", consent is recorded: the policy version,
 *     the time, channel "whatsapp", and this message's id as the evidence;
 *     the code and the sign-up address are cleared.
 * Then ONE welcome DM, on the platform channel, to that number only (refId
 * `pool-welcome:<profile>`, so a resent message cannot welcome him twice).
 *
 * A code that did not work (wrong, expired) is recorded against the number,
 * not the code, and answered at most `codeReplyAllowed` allows: a flood of
 * codes costs one reply, and a number that guessed too many has every code
 * ignored for 24 hours (rules.ts POOL_CONFIRM). A reply never carries a
 * code. MatchTime only ever answers a number that has just written to it.
 */
import { db } from "../db";
import { normaliseLang } from "../i18n/lang";
import { PlatformDmRefused, platformPhoneDigits, queuePlatformDm, type PlatformDmPurpose } from "../platform-jobs";
import {
  codeReplyAllowed,
  confirmWindowStart,
  decidePoolConfirm,
  poolCodeCandidates,
  readPoolConfirmMessage,
  type SenderProfile,
} from "./confirm-rules";
import { poolAlreadyText, poolCodeReplyText, poolWelcomeText } from "./copy";
import { isPoolSignupPaused } from "./flags";
import { buildPoolManageLink } from "./links";
import { POOL_CONSENT_VERSION } from "./rules";

export interface PoolConfirmInput {
  text: string;
  /** The sender's phone as the Pi resolved it (JID, or Contact.number for a LID). */
  phone?: string | null;
  senderAltPhone?: string | null;
  waMessageId: string;
  now?: Date;
}

export interface PoolConfirmOutcome {
  handled: "pool-confirm";
  result: string;
  replied: boolean;
}

export async function handlePoolConfirmDm(input: PoolConfirmInput): Promise<PoolConfirmOutcome | null> {
  if (isPoolSignupPaused()) return null;
  const candidates = poolCodeCandidates(input.text);
  if (candidates.length === 0) return null;
  const now = input.now ?? new Date();
  const out = (result: string, replied = false): PoolConfirmOutcome => {
    console.log(`[pool-confirm] result=${result} replied=${replied}`);
    return { handled: "pool-confirm", result, replied };
  };

  // The same WhatsApp message forwarded twice (a Pi retry, a restart replay).
  if (await db.poolProfile.findFirst({ where: { consentEvidence: input.waMessageId }, select: { id: true } })) {
    return out("duplicate");
  }

  const rows = await db.poolProfile.findMany({
    where: { status: "pending-verify", confirmCode: { in: candidates } },
    select: { id: true, confirmCode: true, confirmCodeExpiresAt: true },
  });
  const row = candidates.map((c) => rows.find((r) => r.confirmCode === c)).find(Boolean) ?? null;

  const phone = senderPhone(input);
  const sender = phone
    ? await db.user.findUnique({ where: { phoneNumber: `+${phone}` }, select: { id: true, poolProfile: { select: { id: true, status: true, language: true } } } })
    : null;
  const failuresToday = phone ? await db.poolConfirmAttempt.count({ where: { phone, createdAt: { gte: confirmWindowStart(now) } } }) : 0;

  const message = readPoolConfirmMessage(input.text);
  const decision = decidePoolConfirm({
    row: row ? { expiresAt: row.confirmCodeExpiresAt } : null,
    hasPhone: phone !== null,
    sender: (sender?.poolProfile ? { status: sender.poolProfile.status } : null) as SenderProfile,
    failuresToday,
    looksLikeConfirm: message !== null,
    now,
  });

  switch (decision.action) {
    case "pass":
      return null;
    case "ignore":
      return out(decision.reason);
    case "failed": {
      await db.poolConfirmAttempt.create({ data: { phone: phone!, result: decision.reply === "expired" ? "expired" : "wrong" } });
      // His profile's language, else the sign-up's, else the message's own.
      const lang = normaliseLang(sender?.poolProfile?.language ?? (row ? await rowLanguage(row.id) : null) ?? message?.lang ?? null);
      return out(decision.reply, await replyIfAllowed(phone!, decision.reply, lang, now));
    }
    case "already-signed-up": {
      const lang = normaliseLang(sender!.poolProfile!.language);
      const text = poolAlreadyText(lang, await buildPoolManageLink(sender!.id));
      return out("already-signed-up", await queueOnce(phone!, text, "pool-welcome", `pool-already:${row!.id}`));
    }
    case "confirm":
      break;
  }

  const confirmed = await confirm(row!.id, phone!, sender?.id ?? null, input.waMessageId, now);
  if (!confirmed) return out("race-lost");
  const text = poolWelcomeText(normaliseLang(confirmed.language), {
    displayName: confirmed.displayName,
    earlyList: confirmed.earlyList,
    manageLink: await buildPoolManageLink(confirmed.userId),
  });
  return out("confirmed", await queueOnce(phone!, text, "pool-welcome", `pool-welcome:${confirmed.id}`));
}

/** The sender's phone, digits, off the envelope; null for a LID alone. */
function senderPhone(input: PoolConfirmInput): string | null {
  for (const raw of [input.phone, input.senderAltPhone]) {
    const d = typeof raw === "string" && raw.trim() ? platformPhoneDigits(raw) : null;
    if (d) return d;
  }
  return null;
}

async function rowLanguage(id: string): Promise<string | null> {
  return (await db.poolProfile.findUnique({ where: { id }, select: { language: true } }))?.language ?? null;
}

/** Make the waiting sign-up live for this number. Null when another
 *  message confirmed it first. */
async function confirm(profileId: string, phone: string, knownUserId: string | null, waMessageId: string, now: Date) {
  return db.$transaction(async (tx) => {
    const row = await tx.poolProfile.findUnique({ where: { id: profileId }, select: { status: true, displayName: true } });
    if (row?.status !== "pending-verify") return null;

    let userId = knownUserId;
    if (!userId) {
      const user = await tx.user.upsert({
        where: { phoneNumber: `+${phone}` },
        update: {},
        create: {
          name: row.displayName,
          phoneNumber: `+${phone}`,
          email: `pool+${phone}-${now.getTime().toString(36)}@matchtime.local`,
          // His own WhatsApp message verified the number: a complete
          // handshake, as a phone sign-up is (phone-signup.ts).
          onboarded: true,
          isActive: true,
        },
        select: { id: true },
      });
      userId = user.id;
    }
    // A stopped profile of his gives way to the new sign-up. An active or
    // paused one never reaches here (decidePoolConfirm), and a race that
    // made one meanwhile fails the unique userId and rolls back.
    await tx.poolProfile.deleteMany({ where: { userId, status: "stopped" } });

    const { count } = await tx.poolProfile.updateMany({
      where: { id: profileId, status: "pending-verify" },
      data: {
        userId,
        status: "active",
        confirmCode: null,
        confirmCodeExpiresAt: null,
        signupIp: null,
        consentAt: now,
        consentVersion: POOL_CONSENT_VERSION,
        consentChannel: "whatsapp",
        consentEvidence: waMessageId,
        lastActiveAt: now,
      },
    });
    if (count !== 1) return null;
    return tx.poolProfile.findUniqueOrThrow({
      where: { id: profileId },
      select: { id: true, userId: true, displayName: true, language: true, earlyList: true },
    }) as Promise<{ id: string; userId: string; displayName: string; language: string; earlyList: boolean }>;
  });
}

/** The "that code did not work" reply, when the rate limit allows it. */
async function replyIfAllowed(phone: string, kind: "expired" | "wrong-code", lang: ReturnType<typeof normaliseLang>, now: Date): Promise<boolean> {
  const earlier = await db.platformJob.findMany({
    where: { purpose: "pool-code-reply", phone, createdAt: { gte: confirmWindowStart(now) } },
    select: { createdAt: true },
  });
  if (!codeReplyAllowed(earlier.map((j) => j.createdAt), now)) return false;
  return queue(phone, poolCodeReplyText(kind, lang), "pool-code-reply", `pool-code:${phone}:${now.getTime()}`);
}

/** Queue a DM unless one with this refId exists already. */
async function queueOnce(phone: string, text: string, purpose: PlatformDmPurpose, refId: string): Promise<boolean> {
  if (await db.platformJob.findFirst({ where: { purpose, refId }, select: { id: true } })) return false;
  return queue(phone, text, purpose, refId);
}

/** False, and logged, when the platform channel refuses it; never thrown at the DM route. */
async function queue(phone: string, text: string, purpose: PlatformDmPurpose, refId: string): Promise<boolean> {
  try {
    await queuePlatformDm({ phone, text, purpose, refId });
    return true;
  } catch (err) {
    if (err instanceof PlatformDmRefused) {
      console.error(`[pool-confirm] ${purpose} not queued: ${err.code}`);
      return false;
    }
    throw err;
  }
}
