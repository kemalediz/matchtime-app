/**
 * A MESSAGE IN A CLUB'S ADMIN GROUP (slice 2a 2026-09-30, picks in 2b
 * 2026-10-01, squad changes 2026-10-14). Plan:
 * MDs/friday-group-features-plan-2026-09-30.md, sections 2.5 and 2.8.
 *
 * The Pi forwards every message in a linked admin group here at once,
 * flagged `channel: "admin-group"`, and never into the analysis history or
 * the analyze batch. MatchTime reads, in this order, and only from an
 * owner or admin of the club (by phone, or a LID pair the server stored
 * itself; never the pushname):
 *
 *   0. "help" / "yardım" in a live club (2026-10-15, `admin-group-help.ts`):
 *      the HQ command list, deterministic, before every reader below;
 *   1. the collector's "PAID ALL / PAID 1 3" for a monthly club;
 *   2. a reply to an open pick round (numbers, names, @tags, ALL, NONE,
 *      YES to a pending question), as a WHOLE message;
 *   3. for a live weekly club (2026-10-14):
 *      a. YES to the teams waiting for approval (`team-proposal.ts`), else
 *         YES to a squad list an admin pasted here (`admin-group-paste.ts`);
 *         only one of the two is ever waiting;
 *      a'. a team command: "teams", "reshuffle", "swap A B", "move A"
 *         (`team-proposal.ts`, deterministic);
 *      b. a pasted squad list: proposed, applied only on YES; with no game
 *         to put it on, one line saying so and when the next game is
 *         made (2026-10-15);
 *      c. one squad change ("Shehryar out", "put Bilal in"), through the
 *         same router and attendance engine as the players' group
 *         (`admin-group-squad-change.ts`).
 *
 * Anything else is ignored with no reply: a non-admin, a club that is not
 * live, a monthly club (today's behaviour, unchanged), chat, questions.
 * The `ignored` labels are the ones this route always gave ("no-open-pick"
 * with no round open, "not-a-pick" or "not-an-admin" with one), so nothing
 * that reads them changes.
 *
 * The answer, when there is one, goes back as `replyText`, which the Pi
 * posts in the same group. Idempotent per WhatsApp message id
 * (`admin-group-msg:<messageId>`), so a Pi retry never applies anything
 * twice.
 *
 * A MODEL ONLY BEHIND 3c, AND THE SHARED TEAM GENERATOR. Until 2026-10-14
 * nothing here could reach a model. Now one module can for reading,
 * `admin-group-squad-change.ts`, and only for a message from an owner or
 * admin of a live weekly club that is not a pick, a PAID, a YES, a team
 * command or a pasted list. The team commands are parsed with no model;
 * "teams" and "reshuffle" build through `generateTeamsForMatch`, the one
 * shared generator, whose rating adjuster is a model call on every path
 * that builds teams (the players' group, the website button) and here.
 * `admin-group-no-model.source.test.ts` follows every import and pins that
 * the rest of this path still reaches none.
 */
import { db } from "./db";
import { resolveSenderUserIds } from "./admin-group-link";
import { handlePickReply } from "./organiser-pick";
import { PICK_RACE_WINDOW_MS } from "./organiser-pick-rules";
import { isBillingPaused } from "./club-billing-rules";
import { handleCollectorPaidReply } from "./month-payment";
import { readCollectorReply } from "./month-payment-rules";
import { answerSquadPasteYes, proposeSquadPaste } from "./admin-group-paste";
import { handleAdminSquadChange } from "./admin-group-squad-change";
import { isAdminGroupYes } from "./admin-group-squad-rules";
import { answerTeamsYes, handleTeamCommand, setAsideTeamProposal } from "./team-proposal";
import { t } from "./i18n/t";
import { handleAdminGraphicsCommand } from "./admin-group-graphics";
import { buildHqHelp, hqHelpGates, isHqHelpRequest } from "./admin-group-help";

export interface AdminGroupMessage {
  groupId: string;
  messageId?: string | null;
  text: string;
  senderPhone?: string | null;
  senderLid?: string | null;
  senderAltPhone?: string | null;
  timestamp?: string | null;
  mentionNames?: Array<{ jid: string; name?: string; phone?: string }>;
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
  | { handled: true; orgId: string; outcome: string | null; replyText: string | null };

type Replied = Extract<AdminGroupMessageResult, { handled: true }>;

function parseTimestamp(ts: string | null | undefined): Date | null {
  if (!ts) return null;
  const n = Number(ts);
  const d = Number.isFinite(n) ? new Date(n < 1e12 ? n * 1000 : n) : new Date(ts);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * 3a to 3c above, for a sender already proven an owner or admin and a
 * message id already claimed. Null when none of them answers.
 */
async function readSquadMessage(args: {
  org: { id: string; language: string | null };
  msg: AdminGroupMessage;
  adminUserId: string;
  now: Date;
}): Promise<Replied | null> {
  const { org, msg, adminUserId, now } = args;
  const messageId = msg.messageId ?? `admin-group:${org.id}:${now.getTime()}`;
  const base = { orgId: org.id, lang: org.language, messageId, senderUserId: adminUserId, now };

  if (isAdminGroupYes(msg.text)) {
    // A YES is never a squad change of its own: with nothing waiting it
    // is chat, and it is never sent to the model. ONE QUESTION AT A TIME
    // (team-proposal.ts): teams waiting for YES and a pasted list waiting
    // for YES are never both open, so trying the teams first can only
    // ever answer the one question that was asked last.
    const teamsYes = await answerTeamsYes(base);
    if (teamsYes) return { handled: true, orgId: org.id, outcome: teamsYes.outcome, replyText: teamsYes.replyText };
    const yes = await answerSquadPasteYes(base);
    return yes ? { handled: true, orgId: org.id, outcome: yes.outcome, replyText: yes.replyText } : null;
  }

  // 3a'. A team command ("teams", "swap A B", "move A", "reshuffle"), as a
  // whole message, deterministic. Before the pasted list and the squad
  // change, so "move Tom" never reaches the model.
  const teamCommand = await handleTeamCommand({ ...base, text: msg.text });
  if (teamCommand) return { handled: true, orgId: org.id, outcome: teamCommand.outcome, replyText: teamCommand.replyText };

  const pasted = await proposeSquadPaste({ ...base, text: msg.text });
  if (pasted) {
    // The list is now the question: teams waiting for YES are set aside.
    const setAside = pasted.outcome === "paste-proposed" ? await setAsideTeamProposal(org.id) : 0;
    const replyText = setAside > 0 ? `${pasted.replyText} ${t(org.language).tp_teams_set_aside}` : pasted.replyText;
    return { handled: true, orgId: org.id, outcome: pasted.outcome, replyText };
  }

  const sender = await db.user.findUnique({ where: { id: adminUserId }, select: { name: true } });
  const change = await handleAdminSquadChange({
    ...base,
    text: msg.text,
    mentionNames: msg.mentionNames,
    senderName: sender?.name ?? null,
    sentAt: parseTimestamp(msg.timestamp),
  });
  return change.handled ? { handled: true, orgId: org.id, outcome: change.outcome, replyText: change.replyText } : null;
}

/**
 * An owner's or admin's "help": the HQ command list for this club. Null
 * when the sender is not one (the caller then carries on, and a non-admin
 * gets exactly what they got before). Claims the message id with the same
 * key as every other admin-group reply, so a Pi retry is answered once.
 */
async function answerHqHelp(
  org: { id: string; language: string | null; squadMode: string | null; benchPickMode?: string | null },
  msg: AdminGroupMessage,
): Promise<AdminGroupMessageResult | null> {
  const senderIds = await resolveSenderUserIds({ phones: [msg.senderPhone, msg.senderAltPhone], lid: msg.senderLid ?? null });
  const admin = senderIds.length
    ? await db.membership.findFirst({
        where: { orgId: org.id, userId: { in: senderIds }, leftAt: null, role: { in: ["OWNER", "ADMIN"] } },
        select: { userId: true },
      })
    : null;
  if (!admin) return null;
  if (msg.messageId) {
    try {
      await db.sentNotification.create({ data: { key: `admin-group-msg:${msg.messageId}`, kind: "admin-notice" } });
    } catch {
      return { handled: false, ignored: "duplicate", orgId: org.id, replyText: null };
    }
  }
  // The same gates as below (squad and team commands for a live weekly
  // club, the posters for any live club, PAID for a monthly one), read from
  // the one place the admin group's introduction reads them too.
  const replyText = buildHqHelp({ lang: org.language, ...hqHelpGates(org) });
  return { handled: true, orgId: org.id, outcome: "hq-help", replyText };
}

export async function handleAdminGroupMessage(msg: AdminGroupMessage): Promise<AdminGroupMessageResult> {
  const now = msg.now ?? new Date();
  const org = await db.organisation.findFirst({
    where: { adminGroupId: msg.groupId },
    select: { id: true, billingStatus: true, whatsappBotEnabled: true, squadMode: true, language: true, benchPickMode: true },
  });
  if (!org) return { handled: false, ignored: "not-an-admin-group", replyText: null };
  // Club fee billing (B1): a club paused for the club fee answers nothing,
  // and nothing is read or written for it. Never while BILLING_ENABLED is
  // off. (The Pi should not forward from a paused club's admin group at
  // all: it is listed silent. This is the server's own refusal.)
  if (isBillingPaused(org)) return { handled: false, ignored: "club-billing-paused", orgId: org.id, replyText: null };

  // "help" (2026-10-15, admin-group-help.ts): the HQ command list, for an
  // owner or admin of a live club. FIRST, so a help request is never read
  // as a pick, a team command or a squad change (which asks the router, a
  // model). Anyone else, or a club that is not live: on as before.
  if (org.whatsappBotEnabled === true && isHqHelpRequest(msg.text)) {
    const help = await answerHqHelp(org, msg);
    if (help) return help;
  }

  // MONTHLY SQUAD (slice 4): the collector answering the claims digest in
  // the admin group ("PAID ALL", "PAID 1 3", "PAID NONE"). Read only when
  // the text is exactly that (a pure check, no query), so every other
  // message in the group goes on as before. Deterministic, no model.
  if (readCollectorReply(msg.text)) {
    const senders = await resolveSenderUserIds({ phones: [msg.senderPhone, msg.senderAltPhone], lid: msg.senderLid ?? null });
    const paid = await handleCollectorPaidReply({ text: msg.text, waMessageId: msg.messageId ?? null, senderUserIds: senders, orgId: org.id, now });
    if (paid) return { handled: true, orgId: org.id, outcome: paid.handled, replyText: paid.replyText || null };
  }

  // "poster" / "team sheet" (2026-10-14, admin-group-graphics.ts): owner or admin only, no model.
  const graphic = await handleAdminGraphicsCommand({ org, msg, now });
  if (graphic) return graphic;

  // Squad changes are read for a LIVE WEEKLY club only: a club still
  // setting up has its bot off, and a monthly club keeps exactly today's
  // behaviour (its list is `monthly-paste.ts`'s, in the players' group).
  const readsSquad = org.whatsappBotEnabled === true && org.squadMode !== "monthly";

  const round = await db.organiserPickRound.findFirst({
    where: {
      orgId: org.id,
      channel: "admin-group",
      OR: [{ resolvedAt: null }, { outcome: "filled", resolvedAt: { gte: new Date(now.getTime() - PICK_RACE_WINDOW_MS) } }],
    },
    select: { id: true },
  });
  // Nothing open and nothing else this club's group is read for: the
  // group is the admins' own conversation, and it stays theirs.
  if (!round && !readsSquad) return { handled: false, ignored: "no-open-pick", orgId: org.id, replyText: null };

  const senderIds = await resolveSenderUserIds({
    phones: [msg.senderPhone, msg.senderAltPhone],
    lid: msg.senderLid ?? null,
  });
  const admin = senderIds.length
    ? await db.membership.findFirst({
        where: { orgId: org.id, userId: { in: senderIds }, leftAt: null, role: { in: ["OWNER", "ADMIN"] } },
        select: { userId: true },
      })
    : null;
  // With no round open a non-admin gets the answer they always got.
  if (!admin) return { handled: false, ignored: round ? "not-an-admin" : "no-open-pick", orgId: org.id, replyText: null };

  if (msg.messageId) {
    try {
      await db.sentNotification.create({ data: { key: `admin-group-msg:${msg.messageId}`, kind: "admin-notice" } });
    } catch {
      return { handled: false, ignored: "duplicate", orgId: org.id, replyText: null };
    }
  }

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
    if (outcome.handled) return { handled: true, orgId: org.id, outcome: outcome.outcome ?? null, replyText: outcome.replyText };
  }

  if (readsSquad) {
    const squad = await readSquadMessage({ org, msg, adminUserId: admin.userId, now });
    if (squad) return squad;
  }
  return { handled: false, ignored: round ? "not-a-pick" : "no-open-pick", orgId: org.id, replyText: null };
}
