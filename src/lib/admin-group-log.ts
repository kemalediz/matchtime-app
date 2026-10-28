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

/** The players' group's rows (2026-10-28, below): MatchTime's question
 *  there, and an organiser's message read in the place of its answer.
 *  Never in what HQ reads. */
export const GROUP_QUESTION_ID_PREFIX = "mt:group:";
export const GROUP_LINE_ID_PREFIX = "group:";
const NOT_GROUP_ROWS = { NOT: [{ waMessageId: { startsWith: GROUP_QUESTION_ID_PREFIX } }, { waMessageId: { startsWith: GROUP_LINE_ID_PREFIX } }] };

export const teamsAskRef = (matchId: string): string => `teams:${matchId}`;
export const listAskRef = (pasteMessageId: string): string => `list:${pasteMessageId}`;

export interface HqLogRow {
  waMessageId: string;
  fromMatchTime: boolean;
  senderUserId: string | null;
  text: string;
  askRef: string | null;
  /** MatchTime's own line: the stanza id of the send, once the Pi acked it
   *  (slice S4 review). Absent on rows from before, and on tests' rows. */
  waStanzaId?: string | null;
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

/**
 * A SCHEDULED post in HQ that asks the organisers something (local player
 * pool L10: the short-squad notice's pool line). The scheduler only emits
 * it; the due-posts route records it once it has CLAIMED it (it is really
 * going out), one row per instruction key (`mt:sched:<key>`), so a re-claim
 * never doubles it. The ack stamps its stanza id (`hq-log-stanza.ts`); a
 * release (the Pi held it) takes it back. Never throws.
 */
export const scheduledHqQuestionId = (key: string): string => `mt:sched:${key}`;

export async function recordScheduledHqQuestion(args: { orgId: string; key: string; askRef: string; text: string; now: Date }): Promise<void> {
  try {
    await db.adminGroupMessage.upsert({
      where: { waMessageId: scheduledHqQuestionId(args.key) },
      create: {
        orgId: args.orgId,
        waMessageId: scheduledHqQuestionId(args.key),
        fromMatchTime: true,
        text: (args.text ?? "").slice(0, MAX_TEXT),
        askRef: args.askRef,
        createdAt: args.now,
      },
      update: {},
    });
  } catch (err) {
    console.error(`[admin-group] scheduled question ${args.askRef} not recorded:`, err instanceof Error ? err.message : "failed");
  }
}

/** The Pi released the post unsent: it asked nothing. Never throws. */
export async function forgetScheduledHqQuestion(key: string): Promise<void> {
  try {
    await db.adminGroupMessage.deleteMany({ where: { waMessageId: scheduledHqQuestionId(key), waStanzaId: null } });
  } catch (err) {
    console.error(`[admin-group] scheduled question for ${key} not taken back:`, err instanceof Error ? err.message : "failed");
  }
}

/** The id prefix of MatchTime's "I can't do that from this group" line. */
export const NOT_HERE_ID_PREFIX = "mt:said:not-here:";

/**
 * A line MatchTime said in HQ that asks nothing (2026-10-22: "I can't do
 * that from this group"), recorded so it is not said again soon. No
 * `askRef`: the safe-YES rule reads only MatchTime's questions. Never throws.
 */
export async function recordMatchTimeLine(args: { orgId: string; idPrefix: string; text: string; now: Date }): Promise<void> {
  try {
    await db.adminGroupMessage.create({
      data: {
        orgId: args.orgId,
        waMessageId: `${args.idPrefix}${args.now.getTime()}:${Math.random().toString(36).slice(2, 8)}`,
        fromMatchTime: true,
        text: (args.text ?? "").slice(0, MAX_TEXT),
        createdAt: args.now,
      },
    });
  } catch (err) {
    console.error(`[admin-group] line ${args.idPrefix} not recorded:`, err instanceof Error ? err.message : "failed");
  }
}

/** MatchTime's questions in HQ since `since` whose ask ref starts with
 *  `prefix`, oldest first (L10: the pool notice's). */
export async function hqQuestionsSince(orgId: string, prefix: string, since: Date): Promise<Array<{ askRef: string; createdAt: Date }>> {
  const rows = await db.adminGroupMessage.findMany({
    where: { orgId, fromMatchTime: true, askRef: { startsWith: prefix }, createdAt: { gte: since }, ...NOT_GROUP_ROWS },
    orderBy: { createdAt: "asc" },
    select: { askRef: true, createdAt: true },
  });
  return (rows ?? []).flatMap((r) => (r.askRef ? [{ askRef: r.askRef, createdAt: r.createdAt }] : []));
}

// ── The players' group's lines about MatchTime's question (2026-10-28) ──
//
// A club with no admin group asks for players in its players' group, and
// MatchTime's "who shall I ask?" is asked there too (`ask-source-group.ts`).
// Its answer is found by the same positional tests as in HQ
// (`ask-source-rules.ts` `sourceQuestionAnswered`), on the same kind of
// rows: MatchTime's question, and the organisers' messages read in the
// place of an answer after it (players' chat is not the organisers' and is
// never logged). Kept in this table, a day like HQ's, under their own id
// prefixes, and left out of everything HQ reads.


/** A question MatchTime asked the organisers in the players' group. Never throws. */
export async function recordGroupQuestion(args: { orgId: string; askRef: string; text: string; now: Date }): Promise<void> {
  try {
    await db.adminGroupMessage.create({
      data: {
        orgId: args.orgId,
        waMessageId: `${GROUP_QUESTION_ID_PREFIX}${args.askRef}:${args.now.getTime()}:${Math.random().toString(36).slice(2, 8)}`,
        fromMatchTime: true,
        text: (args.text ?? "").slice(0, MAX_TEXT),
        askRef: args.askRef,
        createdAt: args.now,
      },
    });
    await prune(args.orgId, args.now);
  } catch (err) {
    console.error(`[ask-source-group] question ${args.askRef} not recorded:`, err instanceof Error ? err.message : "failed");
  }
}

/** An organiser's message in the players' group, read in the place of an
 *  answer to that question. Idempotent per WhatsApp id. Never throws. */
export async function recordGroupOrganiserLine(args: { orgId: string; waMessageId: string; senderUserId: string; text: string; now: Date }): Promise<void> {
  try {
    const waMessageId = `${GROUP_LINE_ID_PREFIX}${args.waMessageId}`;
    await db.adminGroupMessage.upsert({
      where: { waMessageId },
      create: { orgId: args.orgId, waMessageId, senderUserId: args.senderUserId, text: (args.text ?? "").slice(0, MAX_TEXT), createdAt: args.now },
      update: {},
    });
  } catch (err) {
    console.error(`[ask-source-group] ${args.waMessageId}: not recorded:`, err instanceof Error ? err.message : "failed");
  }
}

/** The players' group's rows of a club since `since`, oldest first. */
export async function groupLogSince(orgId: string, since: Date): Promise<HqLogRow[]> {
  return ((await db.adminGroupMessage.findMany({
    where: {
      orgId,
      createdAt: { gte: since },
      OR: [{ waMessageId: { startsWith: GROUP_QUESTION_ID_PREFIX } }, { waMessageId: { startsWith: GROUP_LINE_ID_PREFIX } }],
    },
    orderBy: { createdAt: "asc" },
    select: { waMessageId: true, waStanzaId: true, fromMatchTime: true, senderUserId: true, text: true, askRef: true, createdAt: true },
  })) ?? []) as HqLogRow[];
}

/** HQ rows of a club since `since`, oldest first (never the players' group's). */
export async function hqLogSince(orgId: string, since: Date): Promise<HqLogRow[]> {
  return (await db.adminGroupMessage.findMany({
    where: { orgId, createdAt: { gte: since }, ...NOT_GROUP_ROWS },
    orderBy: { createdAt: "asc" },
    select: { waMessageId: true, waStanzaId: true, fromMatchTime: true, senderUserId: true, text: true, askRef: true, createdAt: true },
  })) as HqLogRow[];
}
