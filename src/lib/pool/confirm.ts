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
 * A CODE BELONGS TO THE SIGN-UP THAT MADE IT; the first number with no
 * profile of its own to send it verifies it (plan 3.1, point 4: the number
 * that reached us is the one recorded). A number that already has a
 * profile, of any status, never gets another sign-up attached: he is told
 * how to manage his own, and the attempt counts against him.
 *
 * Confirming, in ONE transaction with a compare-and-set on the waiting row:
 * the User is found by the number, or created (a member keeps his one
 * identity; two first messages at once from a new number resolve to one
 * User); the profile turns "active" with its consent (policy version, time,
 * channel "whatsapp", this message's id); the code and the sign-up address
 * are cleared; and the append-only consent record gets its row
 * (`consent-record.ts`). Then ONE welcome DM to that number only.
 *
 * Every failure (wrong code, expired, a number that has a profile) is
 * recorded against the NUMBER, for strangers and members alike, and the
 * lock (too many in 24 hours) comes first for everyone: nobody can guess
 * codes for free (rules.ts POOL_CONFIRM). The "that code did not work"
 * reply goes at most so often, decided and queued under a per-number lock
 * so two at once cannot both pass. A reply never carries a code. MatchTime
 * only ever answers a number that has just written to it.
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
import { recordPoolConsent } from "./consent-record";
import { poolAlreadyText, poolCodeReplyText, poolWelcomeText } from "./copy";
import { isPoolSignupPaused } from "./flags";
import { buildPoolManageLink } from "./links";
import { POOL_CONSENT_VERSION } from "./rules";
import type { PoolConfirmAttemptResult } from "./vocab";

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

type Tx = Parameters<Parameters<typeof db.$transaction>[0]>[0];

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
  if (await db.poolConsentRecord.findFirst({ where: { evidence: input.waMessageId }, select: { id: true } })) {
    return out("duplicate");
  }

  const rows = await db.poolProfile.findMany({
    where: { status: "pending-verify", confirmCode: { in: candidates } },
    select: { id: true, confirmCode: true, confirmCodeExpiresAt: true, language: true },
  });
  const row = candidates.map((c) => rows.find((r) => r.confirmCode === c)).find(Boolean) ?? null;

  const phone = senderPhone(input);
  const sender = phone
    ? await db.user.findUnique({ where: { phoneNumber: `+${phone}` }, select: { id: true, poolProfile: { select: { status: true, language: true } } } })
    : null;
  const senderProfile = sender?.poolProfile && sender.poolProfile.status !== "pending-verify" ? sender.poolProfile : null;
  const ownCode =
    !!sender && (await db.poolConsentRecord.count({ where: { userId: sender.id, action: "consent", code: { in: candidates } } })) > 0;
  const failuresToday = phone
    ? await db.poolAttempt.count({ where: { kind: "confirm", key: phone, createdAt: { gte: confirmWindowStart(now) } } })
    : 0;

  const message = readPoolConfirmMessage(input.text);
  const decision = decidePoolConfirm({
    row: row ? { expiresAt: row.confirmCodeExpiresAt } : null,
    hasPhone: phone !== null,
    sender: (senderProfile ? { status: senderProfile.status } : null) as SenderProfile,
    ownCode,
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
      await recordFailure(phone!, decision.reply === "expired" ? "expired" : "wrong");
      // His profile's language, else the sign-up's, else the message's own.
      const lang = normaliseLang(senderProfile?.language ?? row?.language ?? message?.lang ?? null);
      return out(decision.reply, await replyIfAllowed(phone!, poolCodeReplyText(decision.reply, lang), now));
    }
    case "already-signed-up": {
      await recordFailure(phone!, "has-profile");
      const text = poolAlreadyText(normaliseLang(senderProfile!.language), decision.status, await buildPoolManageLink(sender!.id));
      return out("already-signed-up", await replyIfAllowed(phone!, text, now));
    }
    case "confirm":
      break;
  }

  const confirmed = await confirmOnce(row!.id, row!.confirmCode!, phone!, input.waMessageId, now);
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

function recordFailure(phone: string, result: PoolConfirmAttemptResult) {
  return db.poolAttempt.create({ data: { kind: "confirm", key: phone, result } });
}

const isUniqueViolation = (err: unknown) => (err as { code?: string } | null)?.code === "P2002";

/** `confirm`, once more if a first message from a new number lost the race
 *  to create its User (the other one made it: use his). */
async function confirmOnce(profileId: string, code: string, phone: string, waMessageId: string, now: Date) {
  try {
    return await confirm(profileId, code, phone, waMessageId, now);
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    try {
      return await confirm(profileId, code, phone, waMessageId, now);
    } catch (again) {
      if (isUniqueViolation(again)) return null;
      throw again;
    }
  }
}

/** Make the waiting sign-up live for this number. Null when another
 *  message confirmed it first, or the number got a profile meanwhile. */
async function confirm(profileId: string, code: string, phone: string, waMessageId: string, now: Date) {
  return db.$transaction(async (tx: Tx) => {
    const row = await tx.poolProfile.findUnique({ where: { id: profileId }, select: { status: true, displayName: true } });
    if (row?.status !== "pending-verify") return null;

    const existing = await tx.user.findUnique({ where: { phoneNumber: `+${phone}` }, select: { id: true, poolProfile: { select: { id: true } } } });
    if (existing?.poolProfile) return null;
    const userId =
      existing?.id ??
      (
        await tx.user.create({
          data: {
            name: row.displayName,
            phoneNumber: `+${phone}`,
            email: `pool+${phone}-${now.getTime().toString(36)}@matchtime.local`,
            // His own WhatsApp message verified the number: a complete
            // handshake, as a phone sign-up is (phone-signup.ts).
            onboarded: true,
            isActive: true,
          },
          select: { id: true },
        })
      ).id;

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
    await recordPoolConsent(tx, { userId, action: "consent", channel: "whatsapp", evidence: waMessageId, version: POOL_CONSENT_VERSION, phone, code, at: now });
    return tx.poolProfile.findUniqueOrThrow({
      where: { id: profileId },
      select: { id: true, userId: true, displayName: true, language: true, earlyList: true },
    }) as Promise<{ id: string; userId: string; displayName: string; language: string; earlyList: boolean }>;
  });
}

/**
 * A reply to a code that did not work (or to a number that already has a
 * profile), when the per-number rate limit allows it. Decided and queued
 * under one lock per number, so two messages at once cannot both pass.
 */
async function replyIfAllowed(phone: string, text: string, now: Date): Promise<boolean> {
  return db.$transaction(async (tx: Tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`pool-code-reply:${phone}`}))`;
    const earlier = await tx.platformJob.findMany({
      where: { purpose: "pool-code-reply", phone, createdAt: { gte: confirmWindowStart(now) } },
      select: { createdAt: true },
    });
    if (!codeReplyAllowed(earlier.map((j) => j.createdAt), now)) return false;
    return queue(phone, text, "pool-code-reply", `pool-code:${phone}`, tx);
  });
}

/** Queue a DM unless one with this refId exists, under a lock on the refId. */
async function queueOnce(phone: string, text: string, purpose: PlatformDmPurpose, refId: string): Promise<boolean> {
  return db.$transaction(async (tx: Tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${refId}))`;
    if (await tx.platformJob.findFirst({ where: { purpose, refId }, select: { id: true } })) return false;
    return queue(phone, text, purpose, refId, tx);
  });
}

/** False, and logged, when the platform channel refuses it; never thrown at the DM route. */
async function queue(phone: string, text: string, purpose: PlatformDmPurpose, refId: string, tx: Tx): Promise<boolean> {
  try {
    await queuePlatformDm({ phone, text, purpose, refId, client: tx as never });
    return true;
  } catch (err) {
    if (err instanceof PlatformDmRefused) {
      console.error(`[pool-confirm] ${purpose} not queued: ${err.code}`);
      return false;
    }
    throw err;
  }
}

