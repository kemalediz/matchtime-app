/**
 * AN ORGANISER'S MESSAGE IN THE ADMIN GROUP, READ BY THE SHARED PIPELINE
 * (Kemal, 2026-10-16).
 *
 * "There has to be a general module which analyzes the messages coming
 * from multiple groups and then processes accordingly." Every WhatsApp
 * group goes through the same front door: the router (`pipeline/gate.ts`,
 * `pipeline/router.ts`), then the same extractors and owners. A message
 * from a club's admin group (HQ) arrives with the context only HQ has,
 * under the router's organisers' header:
 *
 *   - what MatchTime is waiting to hear from the organisers (teams waiting
 *     for YES, a pasted list waiting for YES);
 *   - the message it replies to, when it is a WhatsApp reply, and whether
 *     that was MatchTime's;
 *   - the last few messages in HQ (`admin-group-log.ts`).
 *
 * The route decides who acts, with the code the rest of MatchTime uses:
 *
 *   self_att, other_att   the attendance engine (`admin-group-squad-change.ts`)
 *   balancer              the teams extractor, then `team-proposal.ts`
 *   approve               the safe-YES rule (`admin-group-confirm-rules.ts`),
 *                         then `answerTeamsYes` / `answerSquadPasteYes`
 *   poster, team_sheet    `admin-group-graphics.ts`
 *   help                  `admin-group-help.ts`
 *   question, score,      one line: not from this group (an organiser
 *   admin_ops             clearly asked MatchTime; never silent on that)
 *   none, offer, unsure   nothing: the organisers' own conversation
 *
 * The caller (`admin-group.ts`) has proven the sender is an owner or admin
 * of a live club, claimed the message id, and tried the readers of
 * STRUCTURED data first (a PAID digest answer, a pick from MatchTime's
 * numbered list, a pasted multi-line squad list). Logs carry ids and
 * counts only.
 */
import { db } from "./db";
import { withOrgAiBudget, getAiBudgetStatus } from "./ai-budget";
import { gateBatch } from "./pipeline/gate";
import { extractForRoute } from "./pipeline/extractors";
import { extractorStubFromEnv } from "./pipeline/extractor-stub";
import { anthropicModel, type PipelineModel } from "./pipeline/llm";
import type { Route } from "./pipeline/types";
import { dayLabel } from "./i18n/dates";
import { t } from "./i18n/t";
import { handleAdminSquadChange, nameMentions } from "./admin-group-squad-change";
import { answerTeamsYes, handleTeamCommand } from "./team-proposal";
import { teamCommandFromFacts } from "./team-proposal-rules";
import { answerSquadPasteYes } from "./admin-group-paste";
import { answerGraphicRequest } from "./admin-group-graphics";
import { buildHqHelp, hqHelpGates } from "./admin-group-help";
import { hqLogSince, listAskRef, recordMatchTimeQuestion, teamsAskRef } from "./admin-group-log";
import { WHICH_ASK_REF, decideApproval, matchQuoted, type QuotedMessage } from "./admin-group-confirm-rules";
import { organisersContext, type PendingWithLabel } from "./admin-group-context";
import { answerPartnerAskYes, parsePartnerAskRef, partnerAskRef, partnerAsksAwaitingApproval } from "./partner-ask";

/** How far back the router's "earlier here" lines reach, and how many. */
const RECENT_MS = 30 * 60 * 1000;
const RECENT_MAX = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface UnderstandInput {
  org: { id: string; language: string | null; squadMode: string | null; benchPickMode?: string | null };
  messageId: string;
  text: string;
  mentionNames?: Array<{ jid: string; name?: string; phone?: string }>;
  quoted: QuotedMessage | null;
  adminUserId: string;
  senderName: string | null;
  sentAt: Date | null;
  now: Date;
  /** Injected in tests only. */
  deps?: { routerModel?: PipelineModel; extractorModel?: PipelineModel };
}

export interface Understood {
  route: Route | null;
  outcome: string;
  replyText: string | null;
}

/** What MatchTime is waiting to hear from the organisers. */
export async function loadPending(orgId: string, now: Date, lang: string | null): Promise<PendingWithLabel[]> {
  const out: PendingWithLabel[] = [];
  const teams = await db.adminTeamProposal.findFirst({
    where: { orgId, state: { in: ["proposed", "uneven-asked"] } },
    orderBy: { askedAt: "desc" },
  });
  if (teams) {
    const match = await db.match.findUnique({ where: { id: teams.matchId }, select: { date: true, status: true } });
    // The same "still a live question" test as `answerTeamsYes`.
    if (match && ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"].includes(match.status) && match.date.getTime() >= now.getTime() - 6 * 60 * 60 * 1000) {
      out.push({ ref: teamsAskRef(teams.matchId), kind: "teams", day: dayLabel(lang, match.date), askedAt: teams.askedAt });
    }
  }
  const list = await db.adminSquadProposal.findFirst({
    // A list past its 30 minutes still counts for a day: its YES is
    // answered "too old" (`answerSquadPasteYes`), as before, not ignored.
    where: { orgId, resolvedAt: null, expiresAt: { gte: new Date(now.getTime() - DAY_MS) } },
    orderBy: { createdAt: "desc" },
  });
  if (list) out.push({ ref: listAskRef(list.waMessageId), kind: "list", day: null, askedAt: list.createdAt });
  // A partner club's ask for a player, waiting for this club's YES
  // (cross-club ask, slice S2). Before its cut-off only.
  // Never fails HQ: before the migration, or on a read error, nothing waits.
  const asks = await partnerAsksAwaitingApproval(orgId, now).catch(() => []);
  for (const a of asks) {
    out.push({ ref: partnerAskRef(a.askId), kind: "partner-ask", day: dayLabel(lang, a.matchDate), club: a.askerName, askedAt: a.askedAt });
  }
  return out;
}

export async function understandAdminMessage(input: UnderstandInput): Promise<Understood | null> {
  const { org, messageId, now } = input;
  const lang = org.language;
  const s = t(lang);
  const weekly = org.squadMode !== "monthly";

  return withOrgAiBudget(org.id, async () => {
    const [pending, logAll, body] = await Promise.all([
      loadPending(org.id, now, lang),
      hqLogSince(org.id, new Date(now.getTime() - DAY_MS)),
      nameMentions(org.id, input.text, input.mentionNames),
    ]);
    const log = logAll.filter((r) => r.waMessageId !== messageId);
    const quotedIsMatchTime = !!input.quoted && (input.quoted.fromMatchTime === true || (!!input.quoted.text && !!matchQuoted(input.quoted.text, log)));
    const recent = log.filter((r) => now.getTime() - r.createdAt.getTime() <= RECENT_MS).slice(-RECENT_MAX);
    const capped = (await getAiBudgetStatus(org.id).catch(() => null))?.capped ?? false;

    const gate = await gateBatch(
      [
        {
          waMessageId: messageId,
          body,
          authorName: input.senderName,
          organisers: { context: organisersContext({ pending, quoted: input.quoted, quotedIsMatchTime, recent }) },
        },
      ],
      { capped, ...(input.deps?.routerModel ? { model: input.deps.routerModel } : {}) },
    );
    const route = gate.routes.find((r) => r.messageId === messageId)?.route ?? null;
    console.log(`[admin-group] ${messageId}: routed ${route ?? "nowhere"} (${pending.length} waiting${input.quoted ? ", a reply" : ""})`);
    const base = { orgId: org.id, lang, messageId, senderUserId: input.adminUserId, now };
    const said = (outcome: string, replyText: string | null): Understood => ({ route, outcome, replyText });

    switch (route) {
      case "approve": {
        const decision = decideApproval({ pending, quoted: input.quoted ? { ...input.quoted, fromMatchTime: quotedIsMatchTime } : null, log, now });
        console.log(`[admin-group] ${messageId}: approval ${decision.kind}${"why" in decision ? ` (${decision.why})` : ""}`);
        if (decision.kind === "approve") {
          if (decision.item.kind === "partner-ask") {
            const askId = parsePartnerAskRef(decision.item.ref);
            const r = askId ? await answerPartnerAskYes({ orgId: org.id, askId, userId: input.adminUserId, lang, now }) : null;
            return r ? said(r.outcome, r.replyText) : said("hq-nothing-waiting", s.hq_nothing_waiting);
          }
          const r = decision.item.kind === "teams" ? await answerTeamsYes(base) : await answerSquadPasteYes(base);
          return r ? said(r.outcome, r.replyText) : said("hq-nothing-waiting", s.hq_nothing_waiting);
        }
        if (decision.kind === "nothing-waiting") return said("hq-nothing-waiting", s.hq_nothing_waiting);
        if (decision.kind === "silent") return null;
        const day = pending.find((i) => i.kind === "teams")?.day ?? "";
        const item = decision.kind === "ask-which" ? null : pending.find((i) => i.ref === decision.item.ref);
        const text =
          decision.kind === "ask-which"
            ? s.hq_confirm_which({ day })
            : decision.item.kind === "teams"
              ? s.hq_confirm_teams({ day })
              : decision.item.kind === "partner-ask"
                ? s.hq_confirm_partner_ask({ asker: item?.club ?? "", day: item?.day ?? "" })
                : s.hq_confirm_list;
        const askRef = decision.kind === "ask-which" ? WHICH_ASK_REF : decision.item.ref;
        await recordMatchTimeQuestion({ orgId: org.id, askRef, text, now, confirm: true });
        return said("hq-confirm-asked", text);
      }
      case "poster":
      case "team_sheet": {
        const r = await answerGraphicRequest({ orgId: org.id, lang, kind: route === "poster" ? "list" : "teams", now });
        return said(r.outcome, r.replyText);
      }
      case "help":
        return said("hq-help", buildHqHelp({ lang, ...hqHelpGates(org) }));
      case "balancer": {
        if (!weekly) return said("hq-not-here", s.hq_not_here);
        const model = input.deps?.extractorModel ?? extractorStubFromEnv() ?? anthropicModel();
        const extracted = await extractForRoute(model, "balancer", {
          id: messageId,
          body,
          authorName: input.senderName,
          tagged: true,
          history: recent.map((r) => ({ author: r.fromMatchTime ? "MatchTime" : null, body: r.text })),
          lastBotPost: [...log].reverse().find((r) => r.fromMatchTime)?.text ?? null,
        });
        if (extracted.facts.kind !== "teams") {
          console.log(`[admin-group] ${messageId}: the teams extractor gave nothing (${extracted.degradations.length} degradation(s))`);
          return null;
        }
        const command = teamCommandFromFacts(extracted.facts);
        if (command.kind === "unclear") {
          return extracted.facts.action === "rename"
            ? said("hq-not-here", s.hq_not_here)
            : said("teams-which-players", s.tp_which_players);
        }
        const r = await handleTeamCommand({ ...base, command });
        return said(r.outcome, r.replyText);
      }
      case "self_att":
      case "other_att": {
        if (!weekly) return said("hq-not-here", s.hq_not_here);
        const change = await handleAdminSquadChange({
          ...base,
          text: input.text,
          namedBody: body,
          mentionNames: input.mentionNames,
          senderName: input.senderName,
          sentAt: input.sentAt,
          route,
        });
        return change.handled ? said(change.outcome, change.replyText) : null;
      }
      case "question":
      case "score":
      case "admin_ops":
        return said("hq-not-here", s.hq_not_here);
      default:
        // none, offer, unsure, or no route at all: the organisers' own
        // conversation, and it stays theirs (#269).
        return null;
    }
  });
}
