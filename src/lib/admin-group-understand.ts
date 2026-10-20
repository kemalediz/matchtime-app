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
 *   question, help        the players' group's question answering, for the
 *                         organisers (`admin-group-question.ts`); the HQ
 *                         menu (`admin-group-help.ts`) for how-it-works,
 *                         and for help it does not answer
 *   ask_group             one place-open ask in the players' group
 *                         (`admin-group-ask-group.ts`)
 *   admin_ops             the shared admin extractor: a free place
 *                         ("Bilal washed the bibs, he's free this week",
 *                         action fee_waiver, or one taken back) is ASKED
 *                         about by `fee-waiver.ts` and given on the YES
 *                         (approve, like a pasted list). The money
 *                         collector may do this one, admin or not. Any
 *                         other instruction: one line, not from this group
 *                         (an organiser clearly asked MatchTime; never
 *                         silent on that)
 *   score                 the players' group's score handling, with HQ's
 *                         context (`admin-group-score.ts`, 2026-10-16):
 *                         anyone reports, only an organiser changes it
 *   unsure                addressed to MatchTime (an @tag, or a reply to
 *                         its own message): the attendance engine, as in
 *                         the players' group (an organiser only), then the
 *                         question answering (2026-10-18), else one line
 *                         saying it did not catch that (2026-10-16).
 *                         Otherwise nothing.
 *   none, offer           nothing: the organisers' own conversation
 *
 * A WhatsApp reply to ANOTHER organiser's message, with no @tag, is the
 * organisers' own conversation whatever the route (FNF HQ, 2026-10-16
 * 23:49: "Imti Rafi AH back" between organisers was routed other_att and got
 * a tick and "I don't know AH yet"). Only approve (the safe-YES rule) and
 * the score keep their own rules for it. A squad change says something back
 * for a claim it did not apply only when the message was addressed to
 * MatchTime (`buildAdminSquadReply`), and the next game's list is not
 * changed before the rolling squad is carried over (`rollingSeedPendingAt`).
 *
 * The caller (`admin-group.ts`) has found the club live, claimed the
 * message id, and, for an owner or admin, tried the readers of STRUCTURED
 * data first (a PAID digest answer, a pick from MatchTime's numbered list,
 * a pasted multi-line squad list). It says whether the sender is an
 * organiser (an owner or admin). Anyone else in HQ (2026-10-16, Kemal:
 * "Anyone in that group should be able to ask questions") gets question,
 * help, poster and team_sheet exactly as an organiser does; approve,
 * balancer, self_att, other_att and ask_group change the club and are an
 * organiser's alone: addressed to MatchTime, one line naming the club's
 * owners and admins ("Only Hamzah or Raihan can change that."), otherwise
 * nothing. Logs carry ids and counts only.
 */
import { loadGroupReplyContexts, parseGroupQuote, type QuotedGroupMessage } from "./reply-context";
import { rosterNameByPhone } from "./roster-name-by-phone";
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
import { hqAddressing, organisersContext, type PendingWithLabel } from "./admin-group-context";
import { answerPartnerAskYes, parsePartnerAskRef, partnerAskRef, partnerAsksAwaitingApproval } from "./partner-ask";
import { askPlayersGroup } from "./admin-group-ask-group";
import { answerHqQuestion } from "./admin-group-question";
import { joinAdminNames } from "./seed-nudge-rules";
import { answerFeeProposalYes, feeProposalsAwaiting, proposeFeeFreeInHq } from "./fee-waiver";
import { parseFeeAskRef } from "./fee-waiver-rules";
import { answerHqScore, hqScoreRouting } from "./admin-group-score";
import { hasScorelineShape } from "./pipeline/score-ask";
import { organisersPickMom } from "./mom-chooser";
import { readHqNameList } from "./admin-group-name-list";

/** How far back the router's "earlier here" lines reach, and how many. */
const RECENT_MS = 30 * 60 * 1000;
const RECENT_MAX = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface UnderstandInput {
  org: {
    id: string;
    language: string | null;
    squadMode: string | null;
    benchPickMode?: string | null;
    /** The HQ help's free-place line: a club that takes match fees. */
    paymentCollectionEnabled?: boolean | null;
    paymentTrackingEnabled?: boolean | null;
    /** The money collector: may ask for and approve a free place in HQ. */
    paymentHolderId?: string | null;
    /** Who chooses Man of the Match (mom-chooser.ts). */
    momChosenBy?: string | null;
  };
  messageId: string;
  text: string;
  mentionNames?: Array<{ jid: string; name?: string; phone?: string }>;
  quoted: QuotedMessage | null;
  /** Who sent it, when MatchTime knows them; null for someone it does not. */
  senderUserId: string | null;
  /** An owner or admin of the club. Only an organiser changes anything. */
  organiser: boolean;
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
  // A free place question waiting for YES (2026-10-16, fee-waiver.ts).
  // Never fails HQ: before the migration, or on a read error, nothing waits.
  const fees = await feeProposalsAwaiting(orgId, now, lang).catch(() => []);
  for (const f of fees) out.push({ ref: f.ref, kind: "fee", day: f.day, names: f.names, undo: f.undo, askedAt: f.askedAt });
  return out;
}

/**
 * "Only Hamzah or Raihan can change that." The club's current owners and
 * admins by first name, in the club's language (`joinAdminNames`, the
 * seed nudge's join), for someone in HQ who asked MatchTime for a change
 * only they can make.
 */
export async function onlyOrganisersLine(orgId: string, lang: string | null): Promise<string> {
  const rows =
    (await db.membership.findMany({
      where: { orgId, leftAt: null, role: { in: ["OWNER", "ADMIN"] } },
      select: { user: { select: { name: true } } },
      orderBy: [{ role: "asc" }, { id: "asc" }],
    })) ?? [];
  return t(lang).hq_only_organisers({ names: joinAdminNames(rows.map((r) => r.user?.name ?? null), lang) });
}

/**
 * The message an HQ reply quotes, resolved (`loadGroupReplyContexts`), or
 * null when it is not a reply. Never throws.
 */
async function quotedHqMessage(
  orgId: string,
  messageId: string,
  quoted: QuotedMessage | null,
  now: Date,
): Promise<QuotedGroupMessage | null> {
  const quote = quoted
    ? parseGroupQuote({
        quotedMessageId: quoted.messageId,
        quotedText: quoted.text,
        quotedFromMatchTime: quoted.fromMatchTime,
        quotedAuthorName: quoted.authorName,
        quotedAuthorPhone: quoted.authorPhone,
      })
    : null;
  if (!quote) return null;
  const out = await loadGroupReplyContexts(db, {
    orgId,
    channel: "hq",
    now,
    messages: [{ id: messageId, quote }],
    batch: [],
    authorByPhone: (phone) => rosterNameByPhone(orgId, phone),
  });
  return out.get(messageId) ?? null;
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
    // THE MESSAGE A REPLY QUOTES (quoted-reply context, slice S4), by its
    // WhatsApp id first: MatchTime's own post (its exact words, from the
    // send) or another organiser's message (who, from HQ's log), else what
    // the Pi saw. Its words then find MatchTime's question in the log, so
    // a YES quoting the teams is known by the post's own id, not by the
    // Pi's copy of its text. Total: a failed read keeps the Pi's.
    const reply = await quotedHqMessage(org.id, messageId, input.quoted, now);
    const quotedWords = reply?.text ?? input.quoted?.text ?? null;
    const quotedIsMatchTime =
      !!input.quoted && (input.quoted.fromMatchTime === true || reply?.author === null || (!!quotedWords && !!matchQuoted(quotedWords, log)));
    // What the safe-YES rule, the addressing and the router read.
    const quoted: QuotedMessage | null = input.quoted ? { ...input.quoted, text: quotedWords, fromMatchTime: quotedIsMatchTime } : null;
    const replyShown: QuotedGroupMessage | null = reply && quotedIsMatchTime && reply.author ? { ...reply, author: null } : reply;
    // Addressed to MatchTime: an @tag (never the bare word, which is talk
    // ABOUT MatchTime), or a WhatsApp reply to MatchTime's own message.
    // A WhatsApp reply to ANOTHER organiser's message, with no @tag, is the
    // organisers talking to each other (FNF HQ 2026-10-16 23:49, "Imti Rafi
    // AH back" quoting an organiser about next week, routed other_att, got
    // a tick and "I don't know AH yet"). Nothing MatchTime does from it.
    const { addressed, toAnotherOrganiser } = hqAddressing({ text: input.text, quoted, quotedIsMatchTime });
    // The score MatchTime is waiting for, and the answers and corrections
    // that go to `score` whatever the model says (`admin-group-score.ts`).
    const score = await hqScoreRouting({
      orgId: org.id,
      lang,
      messageId,
      body,
      addressed,
      senderUserId: input.organiser ? input.senderUserId : null,
      now,
      momByOrganisers: organisersPickMom(org),
    });
    // A reply to MatchTime's own Man of the Match question ("Who was Man
    // of the Match?", "Which Ali...?") answers it, whatever the router
    // calls the name: the score handling reads it (2026-10-18). Decided
    // from the quoted row's question ref, never from the words.
    const quotedRow = quotedIsMatchTime && quotedWords ? matchQuoted(quotedWords, log) : null;
    const answersMomAsk = !!quotedRow?.askRef?.startsWith("mom:") && organisersPickMom(org);
    const recent = log.filter((r) => now.getTime() - r.createdAt.getTime() <= RECENT_MS).slice(-RECENT_MAX);
    // The extractors' recent chat: MatchTime's own lines as MatchTime.
    const history = recent.map((r) => ({ author: r.fromMatchTime ? "MatchTime" : null, body: r.text }));
    // MatchTime's last line in HQ. A reply's quoted message is shown to
    // every extractor beside it (`replyShown`), whoever wrote it.
    const lastHqPost = [...log].reverse().find((r) => r.fromMatchTime)?.text ?? null;
    const capped = (await getAiBudgetStatus(org.id).catch(() => null))?.capped ?? false;

    // An organiser's short list of names with IN/OUT ("Imti\nRafi\nAH\n\nIn",
    // FNF HQ 2026-10-17) is structured data, like a pasted list: a squad
    // change, without asking the router (which once called it `none`). HQ
    // only (`admin-group-name-list.ts`); the players' group is unchanged.
    const nameList = input.organiser ? readHqNameList(body) : null;
    const gate = nameList
      ? { routes: [{ messageId, route: "other_att" as Route, source: "name-list" }], degradations: [] as Array<{ detail: string }> }
      : await gateBatch(
          [
            {
              waMessageId: messageId,
              body,
              authorName: input.senderName,
              organisers: { context: organisersContext({ pending, recent, score: score.waiting }) },
              ...(replyShown ? { reply: replyShown } : {}),
            },
          ],
          {
            now,
            capped,
            scoreAnswerIds: score.scoreAnswerIds,
            scoreCorrectionIds: score.scoreCorrectionIds,
            ...(input.deps?.routerModel ? { model: input.deps.routerModel } : {}),
          },
        );
    const routed = gate.routes.find((r) => r.messageId === messageId);
    const route = routed?.route ?? null;
    // The source says whether the model chose the route or a fallback did
    // (a failed or unparseable router call is `unsure`, source "fallback").
    // Without it the 2026-10-16 FNF incident could not tell the two apart.
    // The router's degradations go on the SAME line (2026-10-18): `vercel
    // logs` shows one line per request, so the separate lines that said why
    // a fallback happened (an id echoed wrong) were only in the dashboard.
    // Ids, routes and errors only, never the message text.
    const why = gate.degradations.length ? `; router: ${gate.degradations.map((d) => d.detail).join(" | ")}` : "";
    console.log(
      `[admin-group] ${messageId}: routed ${route ?? "nowhere"} by ${routed?.source ?? "nothing"} (${pending.length} waiting${input.quoted ? ", a reply" : ""})${why}`,
    );
    const said = (outcome: string, replyText: string | null): Understood => ({ route, outcome, replyText });

    // Someone in HQ who is not an owner or admin (2026-10-16): questions,
    // help and the graphics are theirs too; anything that changes the club
    // is not. Clearly asked of MatchTime (an @tag, or a reply to its own
    // message): one line naming who can. Otherwise it is their own chat,
    // and silent, as an organiser's is. `actor` is set only for an organiser.
    const actor = input.organiser ? input.senderUserId : null;
    // The money collector runs the payments: a free place is theirs to ask
    // for and to say YES to, even when they are not an admin (review of
    // #301, item 8). Nothing else is.
    const feeActor = actor ?? (input.senderUserId && input.senderUserId === org.paymentHolderId ? input.senderUserId : null);
    const notYours = async (): Promise<Understood | null> =>
      addressed ? said("hq-only-organisers", await onlyOrganisersLine(org.id, lang)) : null;
    const base = (senderUserId: string) => ({ orgId: org.id, lang, messageId, senderUserId, now });
    // The players' group's own score handling, with HQ's context
    // (`admin-group-score.ts`). Anyone may report; only an organiser may
    // change a recorded result.
    const scoreHere = async (): Promise<Understood | null> => {
      const r = await answerHqScore({
        orgId: org.id,
        lang,
        messageId,
        body,
        senderUserId: input.senderUserId,
        senderName: input.senderName,
        organiser: input.organiser,
        addressed,
        history,
        reply: replyShown,
        now,
        ...(input.deps?.extractorModel ? { deps: { model: input.deps.extractorModel } } : {}),
      });
      if (r === "organisers-only") return notYours();
      return r ? { route: "score", outcome: r.outcome, replyText: r.replyText } : null;
    };
    // The players' group's own question answering, for the organisers
    // (`admin-group-question.ts`). Null when it answers nothing.
    const hqHelp = buildHqHelp({ lang, ...hqHelpGates(org) });
    const answerQuestion = () =>
      answerHqQuestion({
        orgId: org.id,
        lang,
        messageId,
        body,
        senderUserId: input.senderUserId,
        senderName: input.senderName,
        now,
        history,
        lastBotPost: lastHqPost,
        reply: replyShown,
        hqHelp,
        ...(input.deps?.extractorModel ? { deps: { model: input.deps.extractorModel } } : {}),
      });

    // The safe-YES rule and the score keep their own rules for a quoted
    // message (a YES quoting another organiser is already silent there; a
    // scoreline answering "what was the score?" is still the score).
    const scorelineWhileWaiting = !!score.waiting && hasScorelineShape(body);
    if (answersMomAsk) {
      if (route !== "score") console.log(`[admin-group] ${messageId}: a reply to the Man of the Match question; ${route ?? "nowhere"} -> score`);
      return scoreHere();
    }
    if (toAnotherOrganiser && route !== "approve" && route !== "score" && !(route === "unsure" && scorelineWhileWaiting)) {
      console.log(`[admin-group] ${messageId}: a reply to another organiser, not tagged: their conversation`);
      return null;
    }

    switch (route) {
      case "approve": {
        // Nothing is waiting for a YES, but the result is (2026-10-18 live
        // check: with "WAITING: ... who was Man of the Match" the router
        // called "MoM was Naim" and "Yellow won 7-4" approve). An approve
        // with nothing to approve, while the score or Man of the Match
        // waits, is read by the score handling first; only what it does
        // not own falls through to the YES rules below, unchanged.
        if (pending.length === 0 && score.waiting) {
          const r = await scoreHere();
          if (r && r.outcome !== "hq-not-understood" && r.outcome !== "hq-score-not-changed") {
            console.log(`[admin-group] ${messageId}: approve with nothing to approve, while the result waits: read as the result`);
            return r;
          }
        }
        if (!feeActor) return notYours();
        const decision = decideApproval({ pending, quoted, log, now });
        console.log(`[admin-group] ${messageId}: approval ${decision.kind}${"why" in decision ? ` (${decision.why})` : ""}`);
        // The collector who is not an admin: a free place question only.
        if (!actor) {
          const item = decision.kind === "approve" || decision.kind === "ask" ? decision.item : null;
          if (item?.kind !== "fee") return notYours();
        }
        if (decision.kind === "approve" && decision.item.kind === "fee") {
          const proposalId = parseFeeAskRef(decision.item.ref);
          const r = proposalId ? await answerFeeProposalYes({ orgId: org.id, proposalId, userId: feeActor, lang, now }) : null;
          return r ? said(r.outcome, r.replyText) : said("hq-nothing-waiting", s.hq_nothing_waiting);
        }
        if (decision.kind === "approve" && actor) {
          if (decision.item.kind === "partner-ask") {
            const askId = parsePartnerAskRef(decision.item.ref);
            const r = askId ? await answerPartnerAskYes({ orgId: org.id, askId, userId: actor, lang, now }) : null;
            return r ? said(r.outcome, r.replyText) : said("hq-nothing-waiting", s.hq_nothing_waiting);
          }
          const r = decision.item.kind === "teams" ? await answerTeamsYes(base(actor)) : await answerSquadPasteYes(base(actor));
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
                : decision.item.kind === "fee"
                  ? s.hq_confirm_fee({ names: item?.names ?? "", day: item?.day ?? "" })
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
      case "question": {
        // The players' group's own question answering, for the organisers
        // (`admin-group-question.ts`). The HQ menu answers a how-it-works
        // question there, and anything it does not answer on the help
        // route (2026-10-16, FNF: "MatchTime who are the admins?" came back
        // `help` and got the menu instead of the admins).
        const r = await answerQuestion();
        if (r) return said(r.outcome, r.replyText);
        if (route === "help") return said("hq-help", hqHelp);
        // Nothing answered it. An organiser always hears the one line; anyone
        // else only when they asked MatchTime, else it is their own chat.
        return actor || addressed ? said("hq-not-here", s.hq_not_here) : null;
      }
      case "balancer": {
        if (!actor) return notYours();
        if (!weekly) return said("hq-not-here", s.hq_not_here);
        const model = input.deps?.extractorModel ?? extractorStubFromEnv() ?? anthropicModel();
        const extracted = await extractForRoute(model, "balancer", {
          id: messageId,
          body,
          authorName: input.senderName,
          tagged: true,
          history,
          lastBotPost: lastHqPost,
          reply: replyShown,
          now,
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
        const r = await handleTeamCommand({ ...base(actor), command });
        return said(r.outcome, r.replyText);
      }
      case "self_att":
      case "other_att": {
        if (!actor) return notYours();
        if (!weekly) return said("hq-not-here", s.hq_not_here);
        const change = await handleAdminSquadChange({
          ...base(actor),
          text: input.text,
          namedBody: body,
          mentionNames: input.mentionNames,
          senderName: input.senderName,
          sentAt: input.sentAt,
          route,
          addressed,
          reply: replyShown,
        });
        return change.handled ? said(change.outcome, change.replyText) : null;
      }
      case "ask_group": {
        // One place-open ask in the players' group (`admin-group-ask-group.ts`).
        if (!actor) return notYours();
        if (!weekly) return said("hq-not-here", s.hq_not_here);
        const r = await askPlayersGroup({ orgId: org.id, lang, messageId, now });
        return said(r.outcome, r.replyText);
      }
      case "admin_ops": {
        // A free place (2026-10-16): "Bilal washed the bibs, he's free
        // this week". The players' group's own admin extractor reads the
        // instruction; only `fee_waiver` is done from HQ, by
        // `answerFeeFreeInHq` (fee-waiver.ts). Every other admin action
        // stays the one line. Someone who is not an organiser, untagged,
        // is chatting: silent, and the extractor is not asked.
        if (!feeActor && !addressed) return null;
        const model = input.deps?.extractorModel ?? extractorStubFromEnv() ?? anthropicModel();
        const extracted = await extractForRoute(model, "admin_ops", {
          id: messageId,
          body,
          authorName: input.senderName,
          tagged: true,
          history,
          lastBotPost: lastHqPost,
          reply: replyShown,
          now,
        });
        const facts = extracted.facts;
        if (facts.kind === "admin" && facts.action === "fee_waiver") {
          if (!feeActor) return notYours();
          // MatchTime ASKS; the YES applies it (review of #301, item 2).
          const r = await proposeFeeFreeInHq({
            orgId: org.id,
            lang,
            refs: facts.coveredRefs ?? [],
            undo: facts.undo === true,
            dayPhrase: facts.matchDay ?? null,
            senderUserId: feeActor,
            messageId,
            now,
          });
          return said(r.outcome, r.replyText);
        }
        console.log(`[admin-group] ${messageId}: admin_ops read as ${facts.kind === "admin" ? facts.action : facts.kind}, not done from HQ`);
        return said("hq-not-here", s.hq_not_here);
      }
      case "score":
        return scoreHere();
      case "unsure": {
        // A scoreline ("7-4 mü 7-5 mi") while MatchTime waits for the
        // score, that the router could not place: the score handling
        // reads it, and records only what is clear (2026-10-16 live check:
        // the router sent that Turkish message to `unsure`).
        if (scorelineWhileWaiting) return scoreHere();
        // Not addressed to MatchTime: the organisers' own conversation.
        if (!addressed) return null;
        // Addressed, and the router could not tell what it does (or its
        // call failed): the attendance engine, as in the players' group,
        // then one line rather than silence (FNF, 2026-10-16). The engine
        // changes the squad, so it is tried for an organiser only.
        if (weekly && actor) {
          const change = await handleAdminSquadChange({
            ...base(actor),
            text: input.text,
            namedBody: body,
            mentionNames: input.mentionNames,
            senderName: input.senderName,
            sentAt: input.sentAt,
            route,
            addressed,
          });
          if (change.handled) return said(change.outcome, change.replyText);
        }
        // Then the question answering, for anyone (FNF HQ, 2026-10-18 13:32:
        // "@Match Time what is squad now including bench?" fell back to
        // `unsure` and got "I didn't catch that" instead of the squad).
        const answered = await answerQuestion();
        if (answered) return said(answered.outcome, answered.replyText);
        return said("hq-not-understood", s.hq_not_understood);
      }
      default:
        // none, offer, or no route at all: the organisers' own
        // conversation, and it stays theirs (#269).
        return null;
    }
  });
}
