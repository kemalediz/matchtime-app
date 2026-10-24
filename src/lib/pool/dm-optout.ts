/**
 * THE GENERAL DM OPT-OUT STOPS POOL OFFERS TOO (decision L6.11, the manager,
 * 2026-10-24: "a person who opts out of MatchTime DMs has withdrawn
 * consent"). The DM route's opt-out step (`dm-subscriptions.ts`, "stop",
 * "stop messaging me", "mesaj atma") runs ahead of every other handler, so
 * the pool reader never sees those words. When it takes a general opt-out
 * from someone with a pool profile, this stops the profile by the SAME path
 * as Stop on the manage page (`applyManageAction("stop")`: status stopped,
 * a `PoolConsentRecord` withdrawal with channel whatsapp and his message id
 * as the evidence).
 *
 * He hears the opt-out step's own reply when it sends one (a club member);
 * otherwise (someone in no club, who gets no club reply) one pool line: game
 * offers are stopped, and the link to start again. The other half of the
 * decision, admission refusing pool offers to someone opted out, is
 * `dispatch-rules.ts` `optedOutOfDms`.
 */
import { db } from "../db";
import type { DmSubCommandKind } from "../dm-subscriptions";
import { normaliseLang } from "../i18n/lang";
import { e164Digits } from "../phone";
import { queuePlatformDm } from "../platform-jobs";
import { buildPoolManageLink } from "./links";
import { applyManageAction } from "./manage";
import { poolReplyStoppedText } from "./offer-copy";

/** Bare international digits too (`normalisePhone` takes bare digits only for UK numbers). */
const digitsOf = (p: string | null | undefined) => (p ? (e164Digits(p) ?? "") : "");

/** Only the general opt-out withdraws pool consent; ratings-only does not. (pure) */
export function dmOptOutStopsPool(kind: DmSubCommandKind): boolean {
  return kind === "opt-out-all";
}

/** His pool profile's language, for reading the command when he has no club. */
export async function poolLanguageOf(userId: string): Promise<string | null> {
  const p = await db.poolProfile.findUnique({ where: { userId }, select: { language: true } });
  return p?.language ?? null;
}

/** Never throws: a failed stop is reported as no stop (the route then
 *  carries on exactly as before). */
export async function stopPoolOnDmOptOut(args: {
  userId: string;
  waMessageId: string;
  /** The envelope's phone and alternate phone: the stop needs the DM to come
   *  from HIS number (as a stop by the reader does, L6.3), never a sender
   *  known only by display name. */
  fromPhones: ReadonlyArray<string | null | undefined>;
  sendLine: boolean;
  now?: Date;
}): Promise<{ stopped: boolean }> {
  const now = args.now ?? new Date();
  try {
    const p = await db.poolProfile.findUnique({ where: { userId: args.userId }, select: { status: true, language: true, user: { select: { phoneNumber: true } } } });
    if (!p || (p.status !== "active" && p.status !== "paused")) return { stopped: false };
    const his = digitsOf(p.user?.phoneNumber);
    if (!his || !args.fromPhones.some((f) => digitsOf(f) === his)) return { stopped: false };
    const r = await applyManageAction(args.userId, "stop", { now, via: { channel: "whatsapp", waMessageId: args.waMessageId } });
    console.log(`[pool] ${args.userId}: general DM opt-out: pool offers ${r.ok ? "stopped" : `not stopped (${r.reason})`}`);
    if (!r.ok) return { stopped: false };
    const phone = p.user?.phoneNumber;
    if (args.sendLine && phone) {
      try {
        await queuePlatformDm({ phone, text: poolReplyStoppedText(normaliseLang(p.language), await buildPoolManageLink(args.userId)), purpose: "pool-reply", refId: null });
      } catch (err) {
        console.error(`[pool] ${args.userId}: the stopped line was not queued:`, err instanceof Error ? err.message : "failed");
      }
    }
    return { stopped: true };
  } catch (err) {
    console.error(`[pool] ${args.userId}: general DM opt-out: pool not stopped:`, err instanceof Error ? err.message : "failed");
    return { stopped: false };
  }
}
