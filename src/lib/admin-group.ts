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
 * answered for them, and a member of the club changes who plays there
 * (2026-10-20); what else changes the club stays an owner's or admin's
 * (`admin-group-understand.ts` says who can). In this order:
 *
 *   1. STRUCTURED DATA, read deterministically, because it is data and not
 *      language:
 *      a. the collector's answer to MatchTime's numbered PAID digest
 *         ("PAID ALL", "PAID 1 3") for a monthly club;
 *      b. a reply to an open pick round: numbers, names or @tags from
 *         MatchTime's own numbered list, ALL, NONE;
 *      c. a pasted multi-line squad list (a live weekly club): proposed,
 *         applied only on YES.
 *      Both b and c are WHO PLAYS, so since 2026-10-20 (Kemal) any member
 *      of the club may send them, as an owner or admin may; someone not in
 *      the club may not. A member says YES to the list they pasted; an
 *      owner or admin to anyone's (`admin-group-understand.ts`).
 *   2. EVERYTHING ELSE from anyone in a live club's HQ goes through
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
import { HQ_CANCEL_NOTHING_DONE } from "./match-cancel";

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
  quoted?: {
    messageId?: string | null;
    text?: string | null;
    fromMatchTime?: boolean;
    /** Who wrote it, from the Pi's contact lookup (slice S4): unverified. */
    authorName?: string | null;
    authorPhone?: string | null;
  } | null;
  now?: Date;
  /** The pool switch as the route read it (local player pool L10). */
  poolEnv?: Record<string, string | undefined>;
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
  // An OUT for someone not on the list (2026-10-24): nothing was written.
  // With the answer to a question beside it the outcome is
  // "squad-not-on-list+hq-answered", a real answer, and keeps its tick.
  "squad-not-on-list",
  // The score (2026-10-16): a tick only when it was recorded.
  "hq-score-asked",
  "hq-score-not-changed",
  "hq-score-no-match",
  "hq-score-failed",
  "hq-score-not-played",
  // Man of the Match picked by the organisers (2026-10-18): a tick only
  // when it was recorded.
  "hq-mom-asked",
  "hq-mom-organisers-only",
  "hq-mom-failed",
  // A cancel or "back on" that changed nothing (no such match, 2026-10-22,
  // match-cancel.ts).
  HQ_CANCEL_NOTHING_DONE,
  // The MatchTime player pool asked from HQ (L10) and not asked: closed for
  // the club, nobody near, too late, no game.
  "hq-pool-not-asked",
  "hq-pool-no-match",
  // A YES to a guest who wants to join that sent nothing (L10).
  "hq-join-not-done",
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
      // The HQ help's pool line (admin-group-help.ts `hqHelpGates`).
      featurePlayerPool: true,
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
        select: { userId: true, role: true, guestMatchId: true },
      })) ?? [])
    : [];
  // A guest is never the club's admin (review of #400, M1).
  const admin = memberships.find((m) => !m.guestMatchId && (m.role === "OWNER" || m.role === "ADMIN")) ?? null;
  const senderUserId = admin?.userId ?? memberships[0]?.userId ?? senderIds[0] ?? null;

  // Everything said in a live club's HQ, by anyone, for the safe-YES rule.
  if (live && msg.messageId) {
    await recordHqMessage({ orgId: org.id, waMessageId: msg.messageId, senderUserId, text: msg.text, now });
  }

  // Who may change who plays here: an owner or admin, or any other member
  // of the club (2026-10-20). Their pick and their pasted list are read
  // below; someone not in the club gets neither.
  const squadActor = admin?.userId ?? (memberships.length > 0 ? senderUserId : null);

  // A club that is not live: only its own pick round is read, and only
  // from a member of the club.
  if (!squadActor && !live) return { handled: false, ignored: round ? "not-an-admin" : "no-open-pick", orgId: org.id, replyText: null };

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
      // The quoted id is kept (slice S4): it names MatchTime's own post, or
      // another organiser's message, before any reading of its words.
      quoted: msg.quoted
        ? {
            messageId: msg.quoted.messageId ?? null,
            text: msg.quoted.text ?? null,
            fromMatchTime: msg.quoted.fromMatchTime === true,
            authorName: msg.quoted.authorName ?? null,
            authorPhone: msg.quoted.authorPhone ?? null,
          }
        : null,
      senderUserId,
      organiser,
      member: memberships.length > 0,
      senderName: sender?.name ?? null,
      sentAt: parseTimestamp(msg.timestamp),
      now,
      ...(msg.poolEnv ? { poolEnv: msg.poolEnv } : {}),
    });
  };

  // What the message was not read as. Someone who is not an organiser
  // keeps the label this route always gave them.
  const notRead = (): AdminGroupMessageResult => ({
    handled: false,
    ignored: round ? (admin ? "not-a-pick" : "not-an-admin") : "no-open-pick",
    orgId: org.id,
    replyText: null,
  });

  // 1b. A pick from MatchTime's numbered list, by any member of the club.
  if (round && squadActor) {
    const outcome = await handlePickReply({
      orgId: org.id,
      door: "admin-group",
      senderUserId: squadActor,
      text: msg.text,
      mentionNames: msg.mentionNames,
      sentAt: parseTimestamp(msg.timestamp),
      now,
    });
    if (outcome.handled) return acted(org.id, outcome.outcome ?? null, outcome.replyText);
  }
  if (!live) return notRead();

  // 1c. A pasted squad list (a live weekly club), by any member of the club.
  if (weekly && squadActor) {
    const pasted = await proposeSquadPaste({ orgId: org.id, lang: org.language, messageId, senderUserId: squadActor, now, text: msg.text });
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

  // 1d. A MONTHLY club (2026-10-29): an organiser's pasted list for the
  // coming month, not started yet, proposed for YES like a weekly list
  // (`month-seed-hq.ts`). Read by the month list reader; null for anything
  // else, which goes on below.
  if (!weekly && admin) {
    const { proposeMonthSeedPaste } = await import("./month-seed-hq");
    const seeded = await proposeMonthSeedPaste({ orgId: org.id, lang: org.language, messageId, organiserUserId: admin.userId, text: msg.text, now });
    if (seeded) {
      await recordMatchTimeQuestion({ orgId: org.id, askRef: listAskRef(messageId), text: seeded.replyText, now });
      return acted(org.id, seeded.outcome, seeded.replyText);
    }
  }

  // 2. Everything else, through the shared pipeline, told whether the
  // sender is an organiser. Anyone in HQ (2026-10-16, Kemal: "Anyone in
  // that group should be able to ask questions") gets questions, help and
  // the graphics; what changes the club beyond who plays, they hear who can.
  const understood = await understand(!!admin);
  if (understood) return acted(org.id, understood.outcome, understood.replyText);
  return notRead();
}
