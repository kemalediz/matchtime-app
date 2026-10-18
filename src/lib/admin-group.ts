/**
 * A MESSAGE IN A CLUB'S ADMIN GROUP (slice 2a 2026-09-30; read by the
 * shared pipeline since 2026-10-16). Plan:
 * MDs/friday-group-features-plan-2026-09-30.md, sections 2.5 and 2.8.
 *
 * The Pi forwards every message in a linked admin group (HQ) here at once,
 * flagged `channel: "admin-group"`, never into the players' group's
 * analysis history or batch. The sender is found by phone, or a LID pair
 * the server stored itself; never the pushname. ANYONE in a live club's HQ
 * is read by the shared pipeline (2026-10-16, Kemal: "Anyone in that group
 * should be able to ask questions"): a question, help and the graphics are
 * answered for them; what changes the club stays an owner's or admin's
 * (`admin-group-understand.ts` says who can). For an owner or admin, in
 * this order:
 *
 *   1. STRUCTURED DATA, read deterministically, because it is data and not
 *      language:
 *      a. the collector's answer to MatchTime's numbered PAID digest
 *         ("PAID ALL", "PAID 1 3") for a monthly club;
 *      b. a reply to an open pick round: numbers, names or @tags from
 *         MatchTime's own numbered list, ALL, NONE;
 *      c. a pasted multi-line squad list (a live weekly club): proposed,
 *         applied only on YES.
 *   2. EVERYTHING ELSE from an owner or admin of a live club goes through
 *      the SAME pipeline as the players' group: the shared router with the
 *      organisers' group context, then the shared extractors and owners
 *      (`admin-group-understand.ts`). That is where a team swap, a squad
 *      change, a poster or team sheet request, "what can you do?" and a
 *      YES are understood, in the admins' own words, English or Turkish.
 *      A YES approves only what it is clearly about
 *      (`admin-group-confirm-rules.ts`).
 *
 * Every message of a live club, from anyone, is recorded for a day
 * (`admin-group-log.ts`): the safe-YES rule needs to know whether anybody
 * spoke between MatchTime's question and a YES.
 *
 * Anything else is ignored with no reply: a club that is not live (a
 * non-admin there gets nothing at all), the organisers' own conversation. The `ignored` labels are the
 * ones this route always gave ("no-open-pick" with no round open,
 * "not-a-pick" or "not-an-admin" with one).
 *
 * The answer, when there is one, goes back as `replyText`, which the Pi
 * posts in the same group, and `react` ("✅" on a message MatchTime acted
 * on, 2026-10-16), which the Pi places on the admin's message the way it
 * reacts in the players' group. Idempotent per WhatsApp message id
 * (`admin-group-msg:<messageId>`), so a Pi retry never applies anything
 * twice.
 */
import { db } from "./db";
import { resolveSenderUserIds } from "./admin-group-link";
import { handlePickReply } from "./organiser-pick";
import { PICK_RACE_WINDOW_MS } from "./organiser-pick-rules";
import { isBillingPaused } from "./club-billing-rules";
import { handleCollectorPaidReply } from "./month-payment";
import { readCollectorReply } from "./month-payment-rules";
import { proposeSquadPaste } from "./admin-group-paste";
import { setAsideTeamProposal } from "./team-proposal";
import { t } from "./i18n/t";
import { listAskRef, recordHqMessage, recordMatchTimeQuestion } from "./admin-group-log";
import { understandAdminMessage } from "./admin-group-understand";
import { HQ_FEE_FREE_EXPIRED, HQ_FEE_FREE_NOTHING_DONE } from "./fee-waiver-rules";

export interface AdminGroupMessage {
  groupId: string;
  messageId?: string | null;
  text: string;
  senderPhone?: string | null;
  senderLid?: string | null;
  senderAltPhone?: string | null;
  timestamp?: string | null;
  mentionNames?: Array<{ jid: string; name?: string; phone?: string }>;
  /** The message this one replies to (a WhatsApp reply), as the Pi saw it. */
  quoted?: { messageId?: string | null; text?: string | null; fromMatchTime?: boolean } | null;
  now?: Date;
}

export type AdminGroupMessageResult =
  | { handled: false; ignored: "not-an-admin-group"; replyText: null }
  | {
      handled: false;
      ignored: "no-open-pick" | "not-an-admin" | "not-a-pick" | "duplicate" | "club-billing-paused";
      orgId: string;
      replyText: null;
    }
  | { handled: true; orgId: string; outcome: string | null; replyText: string | null; react: string | null };

/**
 * "It should put a tick if it recognises a command" (Kemal, 2026-10-16).
 * The emoji the Pi places on the admin's message, as it does on a player's
 * IN in the players' group: on everything MatchTime acted on or answered
 * as a command. Not on the one line saying it cannot do, or could not
 * read, what was asked; ignored chat never reaches here.
 */
const NO_TICK: ReadonlySet<string> = new Set([
  "hq-not-here",
  "hq-not-understood",
  "hq-only-organisers",
  // A free place asked for and none given (already paid, not in the squad, no match).
  HQ_FEE_FREE_NOTHING_DONE,
  // A YES to a free place question past its 30 minutes: nothing done.
  HQ_FEE_FREE_EXPIRED,
  // A squad line that changed nothing (owner rule, 2026-10-17: a tick only
  // when something was done or a real answer given): how to make a change,
  // a list that is not set yet. ("squad-change-failed" keeps its tick: it
  // can carry changes that did land beside one that did not.)
  "squad-question",
  "squad-not-set",
  // The score (2026-10-16): a tick only when it was recorded.
  "hq-score-asked",
  "hq-score-not-changed",
  "hq-score-no-match",
  "hq-score-failed",
  // Man of the Match picked by the organisers (2026-10-18): a tick only
  // when it was recorded.
  "hq-mom-asked",
  "hq-mom-organisers-only",
  "hq-mom-failed",
]);
export const HQ_TICK = "✅";

function acted(orgId: string, outcome: string | null, replyText: string | null): AdminGroupMessageResult {
  return { handled: true, orgId, outcome, replyText, react: outcome && NO_TICK.has(outcome) ? null : HQ_TICK };
}

function parseTimestamp(ts: string | null | undefined): Date | null {
  if (!ts) return null;
  const n = Number(ts);
  const d = Number.isFinite(n) ? new Date(n < 1e12 ? n * 1000 : n) : new Date(ts);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function handleAdminGroupMessage(msg: AdminGroupMessage): Promise<AdminGroupMessageResult> {
  const now = msg.now ?? new Date();
  const org = await db.organisation.findFirst({
    where: { adminGroupId: msg.groupId },
    select: {
      id: true,
      billingStatus: true,
      whatsappBotEnabled: true,
      squadMode: true,
      language: true,
      benchPickMode: true,
      // The HQ help's free-place line (admin-group-help.ts `hqHelpGates`).
      paymentCollectionEnabled: true,
      paymentTrackingEnabled: true,
      // The money collector may ask for, and say YES to, a free place.
      paymentHolderId: true,
      // Who chooses Man of the Match (mom-chooser.ts): asked with the score.
      momChosenBy: true,
    },
  });
  if (!org) return { handled: false, ignored: "not-an-admin-group", replyText: null };
  // Club fee billing (B1): a club paused for the club fee answers nothing,
  // and nothing is read or written for it. Never while BILLING_ENABLED is
  // off. (The Pi should not forward from a paused club's admin group at
  // all: it is listed silent. This is the server's own refusal.)
  if (isBillingPaused(org)) return { handled: false, ignored: "club-billing-paused", orgId: org.id, replyText: null };

  // 1a. MONTHLY SQUAD (slice 4): the collector answering the claims digest
  // ("PAID ALL", "PAID 1 3", "PAID NONE"): numbers against MatchTime's own
  // numbered digest. Read only when the text is exactly that.
  if (readCollectorReply(msg.text)) {
    const senders = await resolveSenderUserIds({ phones: [msg.senderPhone, msg.senderAltPhone], lid: msg.senderLid ?? null });
    const paid = await handleCollectorPaidReply({ text: msg.text, waMessageId: msg.messageId ?? null, senderUserIds: senders, orgId: org.id, now });
    if (paid) return acted(org.id, paid.handled, paid.replyText || null);
  }

  const live = org.whatsappBotEnabled === true;
  const weekly = org.squadMode !== "monthly";

  const round = await db.organiserPickRound.findFirst({
    where: {
      orgId: org.id,
      channel: "admin-group",
      OR: [{ resolvedAt: null }, { outcome: "filled", resolvedAt: { gte: new Date(now.getTime() - PICK_RACE_WINDOW_MS) } }],
    },
    select: { id: true },
  });
  // Nothing open and the club is not live: the group is the admins' own
  // conversation, and it stays theirs.
  if (!round && !live) return { handled: false, ignored: "no-open-pick", orgId: org.id, replyText: null };

  const senderIds = await resolveSenderUserIds({
    phones: [msg.senderPhone, msg.senderAltPhone],
    lid: msg.senderLid ?? null,
  });
  // Who the sender is in this club, whatever their role (2026-10-16: only
  // an owner's or admin's membership used to be looked up, so a player
  // asking a question in HQ was recorded, and treated, as nobody).
  const memberships = senderIds.length
    ? ((await db.membership.findMany({
        where: { orgId: org.id, userId: { in: senderIds }, leftAt: null },
        select: { userId: true, role: true },
      })) ?? [])
    : [];
  const admin = memberships.find((m) => m.role === "OWNER" || m.role === "ADMIN") ?? null;
  const senderUserId = admin?.userId ?? memberships[0]?.userId ?? senderIds[0] ?? null;

  // Everything said in a live club's HQ, by anyone, for the safe-YES rule.
  if (live && msg.messageId) {
    await recordHqMessage({ orgId: org.id, waMessageId: msg.messageId, senderUserId, text: msg.text, now });
  }

  // A club that is not live: only its own pick round is read, and only
  // from an organiser.
  if (!admin && !live) return { handled: false, ignored: round ? "not-an-admin" : "no-open-pick", orgId: org.id, replyText: null };

  if (msg.messageId) {
    try {
      await db.sentNotification.create({ data: { key: `admin-group-msg:${msg.messageId}`, kind: "admin-notice" } });
    } catch {
      return { handled: false, ignored: "duplicate", orgId: org.id, replyText: null };
    }
  }

  const messageId = msg.messageId ?? `admin-group:${org.id}:${now.getTime()}`;
  const understand = async (organiser: boolean) => {
    const sender = senderUserId ? await db.user.findUnique({ where: { id: senderUserId }, select: { name: true } }) : null;
    return understandAdminMessage({
      org,
      messageId,
      text: msg.text,
      mentionNames: msg.mentionNames,
      quoted: msg.quoted ? { text: msg.quoted.text ?? null, fromMatchTime: msg.quoted.fromMatchTime === true } : null,
      senderUserId,
      organiser,
      senderName: sender?.name ?? null,
      sentAt: parseTimestamp(msg.timestamp),
      now,
    });
  };

  // Anyone else in a live club's HQ (2026-10-16, Kemal: "Anyone in that
  // group should be able to ask questions"): the shared pipeline, told they
  // are not an organiser. It answers questions, help and the graphics for
  // them, and says who can for anything that changes the club. The
  // structured readers below (a pick, a pasted list) change the club, and
  // stay the organisers'.
  if (!admin) {
    const understood = await understand(false);
    if (understood) return acted(org.id, understood.outcome, understood.replyText);
    return { handled: false, ignored: round ? "not-an-admin" : "no-open-pick", orgId: org.id, replyText: null };
  }

  // 1b. A pick from MatchTime's numbered list.
  if (round) {
    const outcome = await handlePickReply({
      orgId: org.id,
      door: "admin-group",
      senderUserId: admin.userId,
      text: msg.text,
      mentionNames: msg.mentionNames,
      sentAt: parseTimestamp(msg.timestamp),
      now,
    });
    if (outcome.handled) return acted(org.id, outcome.outcome ?? null, outcome.replyText);
  }
  if (!live) return { handled: false, ignored: round ? "not-a-pick" : "no-open-pick", orgId: org.id, replyText: null };

  // 1c. A pasted squad list (a live weekly club).
  if (weekly) {
    const pasted = await proposeSquadPaste({ orgId: org.id, lang: org.language, messageId, senderUserId: admin.userId, now, text: msg.text });
    if (pasted) {
      let replyText = pasted.replyText;
      if (pasted.outcome === "paste-proposed") {
        // The list is now the question: teams waiting for YES are set aside.
        const setAside = await setAsideTeamProposal(org.id);
        if (setAside > 0) replyText = `${replyText} ${t(org.language).tp_teams_set_aside}`;
        await recordMatchTimeQuestion({ orgId: org.id, askRef: listAskRef(messageId), text: replyText, now });
      }
      return acted(org.id, pasted.outcome, replyText);
    }
  }

  // 2. Everything else, through the shared pipeline.
  const understood = await understand(true);
  if (understood) return acted(org.id, understood.outcome, understood.replyText);
  return { handled: false, ignored: round ? "not-a-pick" : "no-open-pick", orgId: org.id, replyText: null };
}
