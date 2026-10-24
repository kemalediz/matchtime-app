/**
 * A MEMBER ANSWERS A NUMBER'S CLAIM (slice L3, manager review of #401).
 * The thin I/O half of `confirm-rules.ts` `confirmTarget`.
 *
 * A club member with no number on his account started the /play WhatsApp
 * step from his profile; a number NO account holds then sent his code.
 * Nothing was attached (`confirm.ts`). His signed-in /profile card asks
 * "A WhatsApp number ending 7041 messaged us with your code. Is this your
 * number?":
 *
 *   yes   the number goes on HIS account (only while it has none, and only
 *         while no other account holds that number), the sign-up turns
 *         active with the consent of that message (channel "whatsapp", its
 *         message id, the consent record), and ONE welcome goes to that
 *         number: the same activation and welcome as the WhatsApp confirm
 *         (`activatePendingProfile`, `queuePoolWelcome`)
 *   no    the code dies at once (the sign-up is discarded: never active,
 *         nothing attached) and the number that wrote hears nothing more,
 *         even if it sends the code again
 *
 * The claim lives and expires with the waiting sign-up: once its code has
 * run out there is no claim to answer and the card offers a fresh start; the daily
 * housekeeping deletes it with every unconfirmed sign-up.
 */
import { db } from "../db";
import { activatePendingProfile, queuePoolWelcome } from "./confirm";

export type MemberClaimResult =
  | { ok: true; answer: "yes" | "no" }
  /** no-claim: none open (answered already, or its code ran out). */
  | { ok: false; reason: "no-claim" | "number-taken" | "has-phone" };

const isUniqueViolation = (err: unknown) => (err as { code?: string } | null)?.code === "P2002";

export async function answerMemberClaim(userId: string, yes: boolean, now: Date = new Date()): Promise<MemberClaimResult> {
  const row = await db.poolProfile.findFirst({
    where: { userId, status: "pending-verify", claimPhone: { not: null }, confirmCodeExpiresAt: { gt: now } },
    select: { id: true, confirmCode: true, confirmCodeExpiresAt: true, claimPhone: true, claimMessageId: true },
  });
  if (!row?.claimPhone || !row.claimMessageId) return { ok: false, reason: "no-claim" };

  if (!yes) {
    // The code dies now. The row (with the claim) is kept only so the
    // number that wrote stays unanswered if it sends the code again
    // (`confirm.ts` is silent on a claimed code); the daily housekeeping
    // deletes it with every unconfirmed sign-up, and starting again on the
    // card deletes it at once. Nothing is attached, nothing is sent.
    await db.poolProfile.updateMany({ where: { id: row.id, status: "pending-verify" }, data: { confirmCodeExpiresAt: now } });
    console.log("[pool-claim] member said no: sign-up discarded");
    return { ok: true, answer: "no" };
  }

  const phone = row.claimPhone;
  const messageId = row.claimMessageId;
  let live: Awaited<ReturnType<typeof activatePendingProfile>> | "has-phone" = null;
  try {
    live = await db.$transaction(async (tx) => {
      const { count } = await tx.user.updateMany({ where: { id: userId, phoneNumber: null }, data: { phoneNumber: `+${phone}` } });
      if (count !== 1) return "has-phone" as const;
      return activatePendingProfile(tx, { profileId: row.id, userId, phone, code: row.confirmCode, waMessageId: messageId, now });
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // Another account holds that number now: never merged. The claim dies.
    await db.poolProfile.deleteMany({ where: { id: row.id, status: "pending-verify" } });
    return { ok: false, reason: "number-taken" };
  }
  if (live === "has-phone") return { ok: false, reason: "has-phone" };
  if (!live) return { ok: false, reason: "no-claim" };
  await queuePoolWelcome(live, phone);
  console.log("[pool-claim] member said yes: number attached, profile active");
  return { ok: true, answer: "yes" };
}
