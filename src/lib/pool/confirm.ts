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
 * the User is found by the number, or a User is created (a member keeps his one
 * identity; two first messages at once from a new number resolve to one
 * User); the profile turns "active" with its consent (policy version, time,
 * channel "whatsapp", this message's id); the code and the sign-up address
 * are cleared; and the append-only consent record gets its row
 * (`consent-record.ts`). Then ONE welcome DM to that number only.
 *
 * SLICE L3 (manager review): a sign-up a club member with no number started
 * from his profile, sent from a number NO account holds, attaches NOTHING.
 * The number waits on the sign-up as a claim (`confirmTarget`) until he
 * answers on his signed-in page ("a number ending 7041 messaged us with
 * your code: is this your number?", `member-claim.ts`); the number that
 * wrote hears only that the sign-up continues in the app. So a code he
 * forwards can never put someone else's number on his account (their DMs,
 * INs and payments would resolve as him). And a member's sign-up only ever
 * ends on HIS account: from a number of ANOTHER account it is refused, the
 * code dies, and that sender hears one neutral line that names nobody
 * (counted as a failed attempt). Only a stranger's /play sign-up goes to
 * whatever account the number already has.
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
  confirmTarget,
  confirmWindowStart,
  decidePoolConfirm,
  poolCodeCandidates,
  readPoolConfirmMessage,
  type SenderProfile,
} from "./confirm-rules";
import { recordPoolConsent } from "./consent-record";
import { poolAlreadyText, poolClaimWaitText, poolCodeReplyText, poolWelcomeText } from "./copy";
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

export type Tx = Parameters<Parameters<typeof db.$transaction>[0]>[0];

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
    select: { id: true, confirmCode: true, confirmCodeExpiresAt: true, language: true, claimPhone: true, userId: true },
  });
  const row = candidates.map((c) => rows.find((r) => r.confirmCode === c)).find(Boolean) ?? null;
  // Slice L3: a member's code that a number has already claimed waits for
  // HIS answer on his page. The same message again (a retry), the code
  // again, or from anyone else: silent, counted for nobody.
  if (row?.claimPhone) return out("claim-waiting");

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
    // Slice L3: a member's sign-up only ever ends on his own account.
    notYours: !!row && confirmTarget({ numberUserId: sender?.id ?? null, starterId: row.userId }).kind === "not-yours",
    now,
  });

  switch (decision.action) {
    case "pass":
      return null;
    case "ignore":
      return out(decision.reason);
    case "failed": {
      await recordFailure(phone!, decision.reply === "expired" ? "expired" : "wrong");
      if (decision.reply === "not-yours") {
        // The code dies: nothing of the member's sign-up reaches this
        // account, and the line below names nobody. In HIS language or the
        // message's own, never the sign-up's.
        await db.poolProfile.updateMany({ where: { id: row!.id, status: "pending-verify", claimPhone: null }, data: { confirmCodeExpiresAt: now } });
        const lang = normaliseLang(senderProfile?.language ?? message?.lang ?? null);
        return out("not-yours", await replyIfAllowed(phone!, poolCodeReplyText("not-yours", lang), now));
      }
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
  if (confirmed.kind === "claim") {
    // Nothing attached. One line to the number that wrote: the sign-up
    // goes on in the app. It names no account and no person.
    const text = poolClaimWaitText(normaliseLang(confirmed.language));
    return out("claim-recorded", await queueOnce(phone!, text, "pool-code-reply", `pool-claim:${confirmed.id}`));
  }
  return out("confirmed", await queuePoolWelcome(confirmed, phone!));
}

/** The ONE welcome to the number a sign-up was confirmed for. */
export async function queuePoolWelcome(
  p: { id: string; userId: string; displayName: string; language: string; earlyList: boolean },
  phone: string,
): Promise<boolean> {
  const text = poolWelcomeText(normaliseLang(p.language), {
    displayName: p.displayName,
    earlyList: p.earlyList,
    manageLink: await buildPoolManageLink(p.userId),
  });
  return queueOnce(phone, text, "pool-welcome", `pool-welcome:${p.id}`);
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

/** Make the waiting sign-up live for this number, or (slice L3) record a
 *  number's claim on a member's sign-up. Null when another message
 *  confirmed it first, or the number got a profile meanwhile. */
async function confirm(profileId: string, code: string, phone: string, waMessageId: string, now: Date) {
  return db.$transaction(async (tx: Tx) => {
    const row = await tx.poolProfile.findUnique({ where: { id: profileId }, select: { status: true, displayName: true, userId: true, language: true, claimPhone: true } });
    if (row?.status !== "pending-verify" || row.claimPhone) return null;

    const existing = await tx.user.findUnique({ where: { phoneNumber: `+${phone}` }, select: { id: true, poolProfile: { select: { id: true } } } });
    // (A member's own number: his waiting sign-up IS his profile row.)
    if (existing?.poolProfile && existing.poolProfile.id !== profileId) return null;
    const target = confirmTarget({ numberUserId: existing?.id ?? null, starterId: row.userId });
    if (target.kind === "not-yours") return null;

    if (target.kind === "member-claim") {
      const { count } = await tx.poolProfile.updateMany({
        where: { id: profileId, status: "pending-verify", claimPhone: null },
        data: { claimPhone: phone, claimMessageId: waMessageId, claimAt: now },
      });
      return count === 1 ? { kind: "claim" as const, id: profileId, language: row.language } : null;
    }

    const userId =
      target.kind === "number-account"
        ? target.userId
        : (
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
    const live = await activatePendingProfile(tx, { profileId, userId, phone, code, waMessageId, now });
    return live ? { kind: "confirmed" as const, ...live } : null;
  });
}

/**
 * The waiting sign-up turns active for `userId`, with its consent (policy
 * version, time, channel "whatsapp", the message's id) and a row in the
 * consent record; the code, the sign-up address and any claim are cleared.
 * Compare-and-set on "pending-verify". Shared by the WhatsApp confirm and a
 * member's yes to a claim (`member-claim.ts`).
 */
export async function activatePendingProfile(
  tx: Tx,
  a: { profileId: string; userId: string; phone: string; code: string | null; waMessageId: string; now: Date },
): Promise<{ id: string; userId: string; displayName: string; language: string; earlyList: boolean } | null> {
  const { count } = await tx.poolProfile.updateMany({
    where: { id: a.profileId, status: "pending-verify" },
    data: {
      userId: a.userId,
      status: "active",
      confirmCode: null,
      confirmCodeExpiresAt: null,
      signupIp: null,
      claimPhone: null,
      claimMessageId: null,
      claimAt: null,
      consentAt: a.now,
      consentVersion: POOL_CONSENT_VERSION,
      consentChannel: "whatsapp",
      consentEvidence: a.waMessageId,
      lastActiveAt: a.now,
    },
  });
  if (count !== 1) return null;
  await recordPoolConsent(tx, {
    userId: a.userId,
    action: "consent",
    channel: "whatsapp",
    evidence: a.waMessageId,
    version: POOL_CONSENT_VERSION,
    phone: a.phone,
    code: a.code,
    at: a.now,
  });
  return tx.poolProfile.findUniqueOrThrow({
    where: { id: a.profileId },
    select: { id: true, userId: true, displayName: true, language: true, earlyList: true },
  }) as Promise<{ id: string; userId: string; displayName: string; language: string; earlyList: boolean }>;
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

