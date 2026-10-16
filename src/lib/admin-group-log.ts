/**
 * WHAT WAS SAID IN A CLUB'S ADMIN GROUP (HQ), FOR ONE DAY (2026-10-16).
 *
 * Two readers, both in `admin-group-understand.ts`:
 *
 *   - the safe-YES rule (`admin-group-confirm-rules.ts`): was anybody else
 *     talking between MatchTime's question and this YES? Does the message
 *     a YES quotes match a question MatchTime asked?
 *   - the shared router's context: the last few messages, so a "yes" to
 *     another organiser reads as their conversation.
 *
 * Every forwarded HQ message of a live club is recorded, whoever sent it.
 * MatchTime's own QUESTIONS (teams waiting for YES, a pasted list waiting
 * for YES, "Is that YES to ...?") are recorded with `askRef` naming what
 * they asked about. Text is cut to 500 characters; rows older than a day
 * are deleted on every write. Logs carry ids and counts only.
 */
import { db } from "./db";

export const HQ_LOG_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_TEXT = 500;

export const teamsAskRef = (matchId: string): string => `teams:${matchId}`;
export const listAskRef = (pasteMessageId: string): string => `list:${pasteMessageId}`;

export interface HqLogRow {
  waMessageId: string;
  fromMatchTime: boolean;
  senderUserId: string | null;
  text: string;
  askRef: string | null;
  createdAt: Date;
}

async function prune(orgId: string, now: Date): Promise<void> {
  await db.adminGroupMessage
    .deleteMany({ where: { orgId, createdAt: { lt: new Date(now.getTime() - HQ_LOG_TTL_MS) } } })
    .catch(() => {});
}

/** One message somebody sent in HQ. Idempotent per WhatsApp id. Never throws. */
export async function recordHqMessage(args: {
  orgId: string;
  waMessageId: string;
  senderUserId: string | null;
  text: string;
  now: Date;
}): Promise<void> {
  try {
    await db.adminGroupMessage.upsert({
      where: { waMessageId: args.waMessageId },
      create: {
        orgId: args.orgId,
        waMessageId: args.waMessageId,
        senderUserId: args.senderUserId,
        text: (args.text ?? "").slice(0, MAX_TEXT),
        createdAt: args.now,
      },
      update: {},
    });
    await prune(args.orgId, args.now);
  } catch (err) {
    console.error(`[admin-group] ${args.waMessageId}: not recorded:`, err instanceof Error ? err.message : "failed");
  }
}

/**
 * A question MatchTime put to the organisers in HQ. `confirm`: it is the
 * safe-YES rule's "Is that YES to ...?" (its id starts "mt:ask:", which is
 * how the rule asks only once). Never throws.
 */
export async function recordMatchTimeQuestion(args: {
  orgId: string;
  askRef: string;
  text: string;
  now: Date;
  confirm?: boolean;
}): Promise<void> {
  try {
    await db.adminGroupMessage.create({
      data: {
        orgId: args.orgId,
        waMessageId: `mt:${args.confirm ? "ask:" : ""}${args.askRef}:${args.now.getTime()}:${Math.random().toString(36).slice(2, 8)}`,
        fromMatchTime: true,
        text: (args.text ?? "").slice(0, MAX_TEXT),
        askRef: args.askRef,
        createdAt: args.now,
      },
    });
    await prune(args.orgId, args.now);
  } catch (err) {
    console.error(`[admin-group] question ${args.askRef} not recorded:`, err instanceof Error ? err.message : "failed");
  }
}

/** HQ rows of a club since `since`, oldest first. */
export async function hqLogSince(orgId: string, since: Date): Promise<HqLogRow[]> {
  return (await db.adminGroupMessage.findMany({
    where: { orgId, createdAt: { gte: since } },
    orderBy: { createdAt: "asc" },
    select: { waMessageId: true, fromMatchTime: true, senderUserId: true, text: true, askRef: true, createdAt: true },
  })) as HqLogRow[];
}
