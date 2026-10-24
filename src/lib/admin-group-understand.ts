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
 *   self_att, other_att   the attendance engine (`admin-group-squad-change.ts`),
 *                         for any member of the club (2026-10-20)
 *   balancer              the teams extractor, then `team-proposal.ts`
 *   approve               the safe-YES rule (`admin-group-confirm-rules.ts`),
 *                         then `answerTeamsYes` / `answerSquadPasteYes`; a
 *                         member who is not an organiser says YES to the
 *                         list they pasted only (2026-10-20)
 *   poster, team_sheet    `admin-group-graphics.ts`
 *   question, help        the players' group's question answering, for the
 *                         organisers (`admin-group-question.ts`); the HQ
 *                         menu (`admin-group-help.ts`) for how-it-works,
 *                         and for help it does not answer
 *   ask_group             one place-open ask in the players' group
 *                         (`admin-group-ask-group.ts`); for a club with
 *                         partner clubs, the admin extractor first says
 *                         whether another club is meant, and then the
 *                         partners are asked (`partner-ask-words.ts`, S6)
 *   admin_ops             the shared admin extractor: players from a
 *                         partner club ("ask Sutton if anyone can play",
 *                         slice S6) are asked for by `partner-ask-words.ts`,
 *                         an organiser's alone; a free place
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
 *                         the players' group (a member of the club), then the
 *                         question answering (2026-10-18), else one line
 *                         saying it did not catch that (2026-10-16).
 *                         Otherwise nothing.
 *   none, offer           nothing: the organisers' own conversation
 *
 * WHAT LEAVES HQ (2026-10-22, Kemal): a post in the players' group
 * (ask_group), an ask to the partner clubs (ask_group, admin_ops recruit)
 * and a DM to every player (admin_ops recruit, stats_blast) are done only
 * when the message tags MatchTime, or the admin extractor says it is spoken
 * to MatchTime (`toMatchTime`). Otherwise nothing happens and nothing is
 * said (`leavesHqUnasked`). Calling a match off or on needs the tag itself.
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
 * organiser (an owner or admin) and whether they are a member of the club.
 * Anyone else in HQ (2026-10-16, Kemal: "Anyone in that group should be
 * able to ask questions") gets question, help, poster and team_sheet
 * exactly as an organiser does. WHO PLAYS is open to every member of the
 * club there (2026-10-20, Kemal and FNF's Raihan, after a player's "Naim is
 * out" did nothing): self_att, other_att, an HQ name list and the unsure
 * attendance try, with an organiser's standing, recorded as the sender.
 * A member pastes a whole squad list and answers the bench pick too
 * (`admin-group.ts`), and says YES to the list they pasted. approve (of
 * anything else), balancer, ask_group and admin_ops still change the club
 * and are an organiser's alone (a free place: also the money collector's).
 * Asked of MatchTime by anyone else, one line naming the club's owners and
 * admins ("Only Hamzah or Raihan can change that."), TAGGED OR NOT
 * (2026-10-20, Kemal): the route itself says the router read a request to
 * MatchTime for that, as an organiser's untagged "make the teams" is one;
 * the organisers' own chat routes none and stays silent. Logs carry ids
 * and counts only.
 */
import { loadGroupReplyContexts, parseGroupQuote, type QuotedGroupMessage } from "./reply-context";
import { rosterMemberByPhone } from "./roster-name-by-phone";
import { db } from "./db";
import { rosterLabels } from "./group-chat-history";
import { withOrgAiBudget, getAiBudgetStatus } from "./ai-budget";
import { gateBatch } from "./pipeline/gate";
import { extractForRouteTraced, persistPipelineTraces, traceRouting, withPipelineTrace, type PipelineTrace } from "./pipeline/trace";
import { extractorStubFromEnv } from "./pipeline/extractor-stub";
import { anthropicModel, type PipelineModel } from "./pipeline/llm";
import type { AdminFacts, Degradation, Route } from "./pipeline/types";
import { dayLabel } from "./i18n/dates";
import { t } from "./i18n/t";
import { handleAdminSquadChange, nameMentions } from "./admin-group-squad-change";
import { answerTeamsYes, handleTeamCommand } from "./team-proposal";
import { teamCommandFromFacts } from "./team-proposal-rules";
import { answerSquadPasteYes } from "./admin-group-paste";
import { answerGraphicRequest } from "./admin-group-graphics";
import { buildHqHelp, hqHelpGates } from "./admin-group-help";
import { NOT_HERE_ID_PREFIX, hqLogSince, listAskRef, recordMatchTimeLine, recordMatchTimeQuestion, teamsAskRef } from "./admin-group-log";
import { hqCancelOrRestore } from "./match-cancel";
import { WHICH_ASK_REF, decideApproval, quotedLogRow, type QuotedMessage } from "./admin-group-confirm-rules";
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
import { answerPairingInHq, pairingsAwaitingOwner } from "./pairing-reply";
import { parsePairingNoticeKey } from "./club-partnership-rules";
import { activePartnerChoices, askPartnersFromWords } from "./partner-ask-words";

/** How far back the router's "earlier here" lines reach, and how many. */
const RECENT_MS = 30 * 60 * 1000;
const RECENT_MAX = 5;
const DAY_MS = 24 * 60 * 60 * 1000;
/** "I can't do that from this group" is said once in this long, per group
 *  (2026-10-22, Kemal: the repeated help advert was noise). */
export const NOT_HERE_QUIET_MS = 6 * 60 * 60 * 1000;

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
  /** An owner or admin of the club. Only an organiser changes the club. */
  organiser: boolean;
  /** A current member of the club, whatever their role. In HQ anyone in
   *  the club changes who plays (2026-10-20); an organiser is one too. */
  member?: boolean;
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
  if (list) out.push({ ref: listAskRef(list.waMessageId), kind: "list", day: null, by: list.proposedByUserId, askedAt: list.createdAt });
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
  // A partner-club pairing waiting for this club's owner to answer
  // (2026-10-21, `pairing-reply.ts`). Never fails HQ.
  const pairings = await pairingsAwaitingOwner(orgId).catch(() => []);
  for (const p of pairings) out.push({ ref: p.ref, kind: "pairing", day: null, club: p.other, ownClub: p.club, askedAt: p.askedAt });
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
    memberByPhone: (phone) => rosterMemberByPhone(orgId, phone),
  });
  return out.get(messageId) ?? null;
}

/** Who may change who plays from HQ: anyone in the club (2026-10-20). */
function squadActorOf(input: Pick<UnderstandInput, "organiser" | "member" | "senderUserId">): string | null {
  return input.organiser || input.member === true ? input.senderUserId : null;
}

/**
 * The trace this request collected for an HQ message (`pipeline/trace.ts`:
 * the router's route, each extractor's facts) and what HQ did with it, an
 * outcome or "silent", onto its `AdminGroupMessage` row (2026-10-24, FNF
 * "Glazers OUT": HQ messages are not AnalyzedMessage rows, so a silent one
 * could not be explained from the database). Never throws: a failed save is
 * logged and HQ carries on.
 */
async function recordHqDecision(orgId: string, waMessageId: string, outcome: string): Promise<void> {
  let trace: PipelineTrace | null = null;
  await persistPipelineTraces(async (id, t) => {
    if (id === waMessageId) trace = t;
  });
  try {
    await db.adminGroupMessage.updateMany({
      where: { orgId, waMessageId },
      data: { hqOutcome: outcome.slice(0, 64), ...(trace ? { pipelineTrace: trace as unknown as object } : {}) },
    });
  } catch (err) {
    console.error(`[admin-group] ${waMessageId}: saving the decision failed (HQ is unaffected):`, err instanceof Error ? err.message : "unknown");
  }
}

export async function understandAdminMessage(input: UnderstandInput): Promise<Understood | null> {
  return withPipelineTrace(async () => {
    const understood = await understandInTrace(input);
    await recordHqDecision(input.org.id, input.messageId, understood?.outcome ?? "silent");
    return understood;
  });
}

async function understandInTrace(input: UnderstandInput): Promise<Understood | null> {
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
    // The logged line it quotes, BY ITS ID first; by its words only when
    // the club knows nothing of the id (review of #341, findings 4 and 5).
    // An id that resolved to an organiser's message is never relabelled
    // MatchTime's by a text match.
    const found = reply?.found === true;
    const hit = input.quoted ? quotedLogRow({ ...input.quoted, text: quotedWords, found }, log) : { row: null, by: null };
    const quotedIsMatchTime =
      !!input.quoted &&
      (input.quoted.fromMatchTime === true || reply?.author === null || (hit.by === "text" && hit.row?.fromMatchTime === true));
    // What the safe-YES rule, the addressing and the router read.
    const quoted: QuotedMessage | null = input.quoted ? { ...input.quoted, text: quotedWords, fromMatchTime: quotedIsMatchTime, found } : null;
    const replyShown: QuotedGroupMessage | null = reply && quotedIsMatchTime && reply.author ? { ...reply, author: null } : reply;
    // Addressed to MatchTime: an @tag (never the bare word, which is talk
    // ABOUT MatchTime), or a WhatsApp reply to MatchTime's own message.
    // A WhatsApp reply to ANOTHER organiser's message, with no @tag, is the
    // organisers talking to each other (FNF HQ 2026-10-16 23:49, "Imti Rafi
    // AH back" quoting an organiser about next week, routed other_att, got
    // a tick and "I don't know AH yet"). Nothing MatchTime does from it.
    const { tagged, addressed, toAnotherOrganiser } = hqAddressing({ text: input.text, quoted, quotedIsMatchTime });
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
    const quotedRow = quotedIsMatchTime && hit.row?.fromMatchTime ? hit.row : null;
    const answersMomAsk = !!quotedRow?.askRef?.startsWith("mom:") && organisersPickMom(org);
    // A reply to MatchTime's own pairing notice answers it ("1", "2",
    // "evet", "no thanks"), whatever the router would call it: decided from
    // the quoted row's question ref, as the Man of the Match answer is, and
    // read by the pairing reader against the notice (2026-10-21). No router
    // call: the ref already says what the message is about.
    const pairingRef = quotedRow?.askRef && parsePairingNoticeKey(quotedRow.askRef) ? quotedRow.askRef : null;
    if (pairingRef && quotedRow) {
      const r = await answerPairingInHq({
        ref: pairingRef,
        orgId: org.id,
        text: input.text,
        senderUserId: input.senderUserId,
        noticeText: quotedRow.text,
        noticeAt: quotedRow.createdAt,
        quoted: true,
        now,
      });
      console.log(`[admin-group] ${messageId}: a reply to the pairing notice: ${r?.outcome ?? "not an answer"}`);
      return r ? { route: null, outcome: r.outcome, replyText: r.replyText } : null;
    }
    const recent = log.filter((r) => now.getTime() - r.createdAt.getTime() <= RECENT_MS).slice(-RECENT_MAX);
    // The extractors' recent chat: MatchTime's own lines as MatchTime, an
    // organiser's under his roster name (never a pushname), the way the
    // players' group's lines are named (`group-chat-history.ts`).
    const names = await rosterLabels(recent.filter((r) => !r.fromMatchTime).map((r) => r.senderUserId)).catch(
      () => new Map<string, string | null>(),
    );
    const history = recent.map((r) => ({
      author: r.fromMatchTime ? "MatchTime" : r.senderUserId ? (names.get(r.senderUserId) ?? null) : null,
      body: r.text,
    }));
    // MatchTime's last line in HQ. A reply's quoted message is shown to
    // every extractor beside it (`replyShown`), whoever wrote it.
    const lastHqPost = [...log].reverse().find((r) => r.fromMatchTime)?.text ?? null;
    const capped = (await getAiBudgetStatus(org.id).catch(() => null))?.capped ?? false;

    // An organiser's short list of names with IN/OUT ("Imti\nRafi\nAH\n\nIn",
    // FNF HQ 2026-10-17) is structured data, like a pasted list: a squad
    // change, without asking the router (which once called it `none`). HQ
    // only (`admin-group-name-list.ts`); the players' group is unchanged.
    const nameList = squadActorOf(input) ? readHqNameList(body) : null;
    const gate = nameList
      ? {
          routes: [{ messageId, route: "other_att" as Route, source: "name-list" as const }],
          degradations: [] as Degradation[],
          modelCalled: false,
          floorEnabled: false,
        }
      : await gateBatch(
          [
            {
              waMessageId: messageId,
              body,
              authorName: input.senderName,
              organisers: { context: organisersContext({ pending, recent, score: score.waiting }), senderIsOrganiser: input.organiser },
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
    // What the router said, kept on the message's HQ row (2026-10-24,
    // `admin-group.ts`): FNF's "Glazers OUT" could not be explained from
    // the database, as HQ messages are not AnalyzedMessage rows.
    // The name list's "name-list" source is not a router source; the trace
    // stores it as the string it is.
    traceRouting(gate as Parameters<typeof traceRouting>[0]);
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
    // "I can't do that from this group": one short line, and not again while
    // it was said here in the last few hours (the log keeps a day).
    const notHere = async (): Promise<Understood> => {
      const saidLately = log.some(
        (r) => r.fromMatchTime && r.waMessageId.startsWith(NOT_HERE_ID_PREFIX) && now.getTime() - r.createdAt.getTime() <= NOT_HERE_QUIET_MS,
      );
      if (saidLately) {
        console.log(`[admin-group] ${messageId}: not done here, said lately: silent`);
        return said("hq-not-here", null);
      }
      await recordMatchTimeLine({ orgId: org.id, idPrefix: NOT_HERE_ID_PREFIX, text: s.hq_not_here, now });
      return said("hq-not-here", s.hq_not_here);
    };

    // Someone in HQ who is not an owner or admin (2026-10-16): questions,
    // help and the graphics are theirs too; anything that changes the club
    // beyond who plays is not. A route that asks MatchTime for such a
    // change (approve, balancer, ask_group, admin_ops) gets one line naming
    // who can, tagged or not (2026-10-20, Kemal: untagged it was silent).
    // `actor` is set only for an organiser.
    const actor = input.organiser ? input.senderUserId : null;
    // Who plays is open to everyone in the club here (2026-10-20, Kemal and
    // FNF's Raihan, after a player's "Naim is out" did nothing): putting
    // someone in, taking them out, the bench. Recorded as the sender's own.
    const squadActor = squadActorOf(input);
    // The money collector runs the payments: a free place is theirs to ask
    // for and to say YES to, even when they are not an admin (review of
    // #301, item 8). Nothing else is.
    const feeActor = actor ?? (input.senderUserId && input.senderUserId === org.paymentHolderId ? input.senderUserId : null);
    const onlyOrganisers = async (): Promise<Understood> => said("hq-only-organisers", await onlyOrganisersLine(org.id, lang));
    // The same line where the route alone is not a request to MatchTime (a
    // claim about who plays, a score): only when addressed to it.
    const notYours = async (): Promise<Understood | null> => (addressed ? onlyOrganisers() : null);
    // Who may say YES to what is waiting: an organiser to anything; the
    // collector to a free place; the member who pasted a list to that list
    // (2026-10-20: anyone who may paste confirms their own paste).
    const mayApprove = (i: PendingWithLabel): boolean =>
      !!actor || (i.kind === "fee" ? !!feeActor : i.kind === "list" && !!squadActor && i.by === squadActor);
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

    // The shared admin extractor on this message, told truly whether the bot
    // was tagged. Null when its call fails or it reads nothing.
    const readAdminFacts = async (): Promise<AdminFacts | null> => {
      const model = input.deps?.extractorModel ?? extractorStubFromEnv() ?? anthropicModel();
      const extracted = await extractForRouteTraced("admin_ops", model, "admin_ops", {
        id: messageId,
        body,
        authorName: input.senderName,
        tagged,
        history,
        lastBotPost: lastHqPost,
        reply: replyShown,
        now,
      }).catch(() => null);
      return extracted?.facts.kind === "admin" ? extracted.facts : null;
    };
    // AN ACTION THAT LEAVES HQ (a post in the players' group, an ask to the
    // partner clubs, a DM to every player) is done only when it is asked of
    // MatchTime (Kemal, 2026-10-22). FNF HQ 07:22 UTC: "@Kemal can we ask
    // Sutton group?", a question to a person, was routed ask_group and
    // posted "We need 3 more players" in the players' group. A tag on
    // MatchTime asks it; untagged, the model says whether the message is
    // spoken to MatchTime (`toMatchTime`), never the words read by code. A
    // failed read leaves nothing done. Logs carry ids only.
    const leavesHqUnasked = (facts: AdminFacts | null): boolean => {
      if (tagged || facts?.toMatchTime === true) return false;
      console.log(`[admin-group] ${messageId}: ${route} not asked of MatchTime (${facts ? "spoken to others" : "not read"}): nothing leaves HQ`);
      return true;
    };

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
        const decision = decideApproval({ pending, quoted, log, now });
        console.log(`[admin-group] ${messageId}: approval ${decision.kind}${"why" in decision ? ` (${decision.why})` : ""}`);
        // Not an organiser: a YES that is about nothing stays theirs, and
        // one about something they may not approve gets the one line.
        if (!actor) {
          if (decision.kind === "silent") return null;
          const about = decision.kind === "approve" || decision.kind === "ask" ? [decision.item] : decision.kind === "ask-which" ? decision.items : [];
          if (!about.some((i) => mayApprove(i as PendingWithLabel))) return onlyOrganisers();
        }
        if (decision.kind === "approve") {
          const item = decision.item;
          if (item.kind === "fee") {
            const proposalId = parseFeeAskRef(item.ref);
            const r = proposalId && feeActor ? await answerFeeProposalYes({ orgId: org.id, proposalId, userId: feeActor, lang, now }) : null;
            return r ? said(r.outcome, r.replyText) : said("hq-nothing-waiting", s.hq_nothing_waiting);
          }
          if (item.kind === "pairing") {
            // The router heard a yes to what is waiting; the pairing reader
            // says which way, against the notice, and the writer decides
            // whether this person may (owner only).
            const row = [...log].reverse().find((r) => r.fromMatchTime && r.askRef === item.ref) ?? null;
            const r = await answerPairingInHq({
              ref: item.ref,
              orgId: org.id,
              text: input.text,
              senderUserId: input.senderUserId,
              noticeText: row?.text ?? null,
              noticeAt: row?.createdAt ?? null,
              quoted: decision.why === "quoted",
              now,
            });
            return r ? said(r.outcome, r.replyText) : null;
          }
          if (item.kind === "partner-ask" && actor) {
            const askId = parsePartnerAskRef(item.ref);
            const r = askId ? await answerPartnerAskYes({ orgId: org.id, askId, userId: actor, lang, now }) : null;
            return r ? said(r.outcome, r.replyText) : said("hq-nothing-waiting", s.hq_nothing_waiting);
          }
          if (item.kind === "teams" && actor) {
            const r = await answerTeamsYes(base(actor));
            return r ? said(r.outcome, r.replyText) : said("hq-nothing-waiting", s.hq_nothing_waiting);
          }
          if (item.kind === "list" && squadActor) {
            // A member's YES applies the list they pasted, and no other.
            const r = await answerSquadPasteYes({ ...base(squadActor), ...(actor ? {} : { proposedBy: squadActor }) });
            return r ? said(r.outcome, r.replyText) : said("hq-nothing-waiting", s.hq_nothing_waiting);
          }
          return onlyOrganisers();
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
                : decision.item.kind === "pairing"
                  ? s.hq_confirm_pairing({ club: item?.ownClub ?? "", other: item?.club ?? "" })
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
        return actor || addressed ? notHere() : null;
      }
      case "balancer": {
        if (!actor) return onlyOrganisers();
        if (!weekly) return notHere();
        const model = input.deps?.extractorModel ?? extractorStubFromEnv() ?? anthropicModel();
        const extracted = await extractForRouteTraced("balancer", model, "balancer", {
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
            ? notHere()
            : said("teams-which-players", s.tp_which_players);
        }
        const r = await handleTeamCommand({ ...base(actor), command });
        return said(r.outcome, r.replyText);
      }
      case "self_att":
      case "other_att": {
        if (!squadActor) return notYours();
        if (!weekly) return notHere();
        const change = await handleAdminSquadChange({
          ...base(squadActor),
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
        if (!actor) return onlyOrganisers();
        if (!weekly) return notHere();
        // A club with partner clubs (slice S6, 2026-10-21): "ask Sutton if
        // anyone can play", "diğer gruplara sor" route here, as finding a
        // player does. The shared admin extractor says whether ANOTHER club
        // is meant, and which; then the partners are asked instead. The
        // router's turn is unchanged (a sentence for it there cost the free
        // places and Man of the Match answers, measured).
        //
        // Untagged, the same extractor also says whether the message is
        // spoken to MatchTime at all (2026-10-22, FNF HQ: "@Kemal can we ask
        // Sutton group?" was posted in the players' group): see
        // `leavesHqUnasked`. A tagged ask from a club with no partner pays no
        // extra call and gets exactly what it got before.
        const partners = await activePartnerChoices(org.id).catch(() => []);
        const facts = !tagged || partners.length > 0 ? await readAdminFacts() : null;
        if (leavesHqUnasked(facts)) return null;
        if (partners.length > 0) {
          if (facts?.action === "recruit" && facts.partnerClubs) {
            const r = await askPartnersFromWords({ orgId: org.id, requestedByUserId: actor, via: "hq", clubRef: facts.clubRef ?? null, lang, now });
            return said(r.outcome, r.replyText);
          }
        }
        const r = await askPlayersGroup({ orgId: org.id, lang, messageId, now });
        return said(r.outcome, r.replyText);
      }
      case "admin_ops": {
        // A free place (2026-10-16): "Bilal washed the bibs, he's free
        // this week". The players' group's own admin extractor reads the
        // instruction; only `fee_waiver` is done from HQ, by
        // `answerFeeFreeInHq` (fee-waiver.ts). Every other admin action
        // stays the one line. Someone who is neither an organiser nor the
        // collector may do none of it: the line naming who can, tagged or
        // not (2026-10-20), and the extractor is not asked.
        if (!feeActor) return onlyOrganisers();
        const facts = (await readAdminFacts()) ?? { kind: "none" as const };
        // Asking other clubs, or DMing every player, reaches people outside
        // HQ: only when asked of MatchTime (2026-10-22). Untagged and spoken
        // to someone else, not even the "not from this group" line.
        if (facts.kind === "admin" && (facts.action === "recruit" || facts.action === "stats_blast") && leavesHqUnasked(facts)) return null;
        // Another club's players (slice S6, 2026-10-21): "ask Sutton if
        // anyone can play", "search for players from our partner groups".
        // The shared door every surface uses (`partner-ask-words.ts`);
        // an organiser's alone, like ask_group (the collector may not).
        if (facts.kind === "admin" && facts.action === "recruit" && facts.partnerClubs) {
          if (!actor) return onlyOrganisers();
          const r = await askPartnersFromWords({
            orgId: org.id,
            requestedByUserId: actor,
            via: "hq",
            clubRef: facts.clubRef ?? null,
            lang,
            now,
          });
          return said(r.outcome, r.replyText);
        }
        // Calling a match off, or putting it back on (2026-10-22): an owner's
        // or admin's alone (the collector may not), a weekly club only
        // (monthly squads are not live: the website does it). The one path
        // the web page uses (`match-cancel.ts`).
        if (facts.kind === "admin" && (facts.action === "cancel_match" || facts.action === "restore_match")) {
          // Only when an organiser TAGS MatchTime (Kemal, 2026-10-22: "it only
          // acts when an admin tags it"). Untagged, "storm, no game Friday" is
          // the organisers telling each other: nothing written, nothing said.
          if (!tagged) {
            console.log(`[admin-group] ${messageId}: ${facts.action} not tagged: their conversation`);
            return null;
          }
          if (!actor) return onlyOrganisers();
          if (!weekly) return said("hq-cancel-monthly", s.hq_cancel_monthly);
          const r = await hqCancelOrRestore({
            orgId: org.id,
            lang,
            mode: facts.action === "cancel_match" ? "cancel" : "restore",
            dayPhrase: facts.matchDay ?? null,
            addressed,
            now,
          });
          return r ? said(r.outcome, r.replyText) : null;
        }
        if (facts.kind === "admin" && facts.action === "fee_waiver") {
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
        return notHere();
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
        // changes the squad, so it is tried for a member of the club only.
        if (weekly && squadActor) {
          const change = await handleAdminSquadChange({
            ...base(squadActor),
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
