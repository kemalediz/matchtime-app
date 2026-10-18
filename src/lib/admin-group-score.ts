/**
 * THE MATCH SCORE, REPORTED IN A CLUB'S ADMIN GROUP (HQ), THROUGH THE SAME
 * SCORE HANDLING AS THE PLAYERS' GROUP (Kemal, 2026-10-16).
 *
 * The router's `score` route in HQ comes here, and this hands the message
 * to `runScoreBatch` (`score-engine-batch.ts`): the same score extractor,
 * the same engine rules (`handleScore`: which match, whose number is
 * whose, "which team won?" when nothing says), the same writer
 * (`setMatchScore`) and the same Elo reconcile (`buildScoreApplyDeps`).
 * A score recorded here is exactly a score recorded in the players' group;
 * everything after it (Elo, the match COMPLETED, MoM, results) follows
 * from the same rows.
 *
 * What HQ adds, and only this:
 *
 *   - CLEAR OR ASK. A message with more than one possible scoreline
 *     ("7-4 or 7-5") is not recorded: one short question, and the answer
 *     (a reply, or the organiser's next message) goes through the batch.
 *     A scoreline with no team named is the engine's own "which team
 *     won?", answered the same way.
 *   - WHO. Anyone in HQ may report a first result (it is information,
 *     like a question). Only an owner or admin may CHANGE a recorded one:
 *     anyone else is handed to the caller's "only the organisers" line.
 *     A non-organiser reaches the engine without a user id, which is the
 *     engine's own rule for "may report, may never correct".
 *   - ADDRESSED. HQ is the organisers' channel and the router has already
 *     decided the message reports the score, so an organiser's message
 *     counts as addressed to MatchTime (the engine's `tagged`): an
 *     organiser can correct a result in their own words.
 *   - WORDING. "Score saved: Yellow 7, Red 4." with a ✅ (the caller's
 *     tick), in the club's language.
 *
 * MAN OF THE MATCH, WHERE THE ORGANISERS PICK IT (2026-10-18,
 * mom-chooser.ts). The same message, read by the same score extractor,
 * also names the Man of the Match (`momRef`): "Yellow won 7-4, MoM Naim",
 * or the name alone in a later message. The name is resolved against the
 * match's players (`resolvePerson`) and written by `setMatchMom`
 * (mom-pick.ts), the one writer, as the MoMVote row every MoM reader
 * already counts. Only an owner or admin sets or changes it. An unclear
 * name, or one not in the match, is asked about once; a score saved with
 * no name asks "Who was Man of the Match?" once. A club whose players
 * vote never reads `momRef`: its replies are unchanged.
 */
import { t } from "./i18n/t";
import { dayLabel } from "./i18n/dates";
import { buildScoreApplyDeps } from "./owner-deps";
import { runScoreBatch } from "./score-engine-batch";
import type { ScoreApplyDeps } from "./score-engine";
import { enabledStepSevenRoutes } from "./pipeline/route-flags";
import { statesSeveralScorelines } from "./pipeline/score-ask";
import { latestPlayedMatch, loadOpenScoreAsk, loadUnscoredPlayedMatch, scoreRouteOverrides } from "./pipeline/load-awaiting-answer";
import { SCORE_CORRECTION_WINDOW_MS } from "./pipeline/score-window";
import { db } from "./db";
import type { PipelineModel } from "./pipeline/llm";
import type { SquadState } from "./pipeline/types";
import { recordMatchTimeQuestion } from "./admin-group-log";
import type { ScoreWaiting } from "./admin-group-context";
import { organisersPickMom } from "./mom-chooser";
import { momAskRef, momPickDeps, resolveMomRef, type MomPickDeps } from "./mom-pick";
import { joinChoice } from "./i18n/text";

/** What `recordMatchTimeQuestion` files a score question under. */
export const scoreAskRef = (matchId: string) => `score:${matchId}`;

export interface HqScoreInput {
  orgId: string;
  lang: string | null;
  messageId: string;
  body: string;
  senderUserId: string | null;
  senderName: string | null;
  /** An owner or admin of the club. */
  organiser: boolean;
  /** An @tag, or a reply to MatchTime's own message. */
  addressed: boolean;
  history: Array<{ author: string | null; body: string }>;
  now: Date;
  /** Injected in tests only. */
  deps?: {
    model?: PipelineModel;
    loadState?: (orgId: string, now: Date) => Promise<SquadState>;
    apply?: ScoreApplyDeps;
    /** The live check keeps HQ's log out of any database. */
    recordQuestion?: typeof recordMatchTimeQuestion;
    /** Man of the Match's reads and writer (mom-pick.ts). */
    mom?: MomPickDeps;
  };
}

export type HqScoreResult = { outcome: string; replyText: string | null } | "organisers-only" | null;

/**
 * The score in HQ: recorded, asked about once, or refused. Null when
 * there is nothing to say (someone's own chat, or nothing to change).
 */
export async function answerHqScore(input: HqScoreInput): Promise<HqScoreResult> {
  const { orgId, lang, messageId, body, organiser, addressed, now } = input;
  const s = t(lang);
  const speaks = organiser || addressed;
  const recordQuestion = input.deps?.recordQuestion ?? recordMatchTimeQuestion;

  const state = input.deps?.loadState
    ? await input.deps.loadState(orgId, now)
    : await (await import("./pipeline/load-state")).loadSquadState(orgId, now);
  const played = state.completedMatch;
  if (!played) return speaks ? { outcome: "hq-score-no-match", replyText: s.hq_score_no_match } : null;
  const recorded = played.redScore !== null && played.yellowScore !== null;

  // A recorded result is changed by an owner or admin only.
  if (recorded && !organiser) return addressed ? "organisers-only" : null;

  // Clear or ask: two scorelines in one message are not a result.
  if (statesSeveralScorelines(body)) {
    if (!speaks) return null;
    await recordQuestion({ orgId, askRef: scoreAskRef(played.id), text: s.hq_score_unclear, now });
    console.log(`[admin-group] ${messageId}: score unclear (several scorelines); asked`);
    return { outcome: "hq-score-asked", replyText: s.hq_score_unclear };
  }

  const batch = await runScoreBatch({
    orgId,
    now,
    messages: [
      {
        waMessageId: messageId,
        body,
        authorName: input.senderName,
        senderUserId: organiser ? input.senderUserId : null,
        senderName: input.senderName,
        tagged: speaks,
        route: "score",
        gated: false,
      },
    ],
    history: input.history,
    enabled: enabledStepSevenRoutes(process.env),
    deps: {
      ...(input.deps?.apply ?? buildScoreApplyDeps()),
      loadState: async () => state,
      ...(input.deps?.model ? { model: input.deps.model } : {}),
    },
  });
  for (const d of batch.degradations) console.log(`[admin-group] ${messageId}: score: ${d}`);
  const o = batch.outcomes.get(messageId);
  // Not a score after all (the extractor found none): one line only to
  // somebody who asked MatchTime; otherwise it was their own chat.
  if (!o) return addressed ? { outcome: "hq-not-understood", replyText: s.hq_not_understood } : null;
  if (o.writeFailed) return { outcome: "hq-score-failed", replyText: s.hq_score_failed };

  const [redLabel, yellowLabel] = played.teamLabels ?? state.teamLabels;
  let scoreSaid: { outcome: string; replyText: string | null } | null = null;
  if (o.recorded) {
    const { red, yellow, previous } = o.recorded;
    console.log(`[admin-group] ${messageId}: score ${previous ? "changed" : "saved"} on ${o.matchId} (${o.eloApplied} rating(s) moved)`);
    scoreSaid = previous
      ? {
          outcome: "hq-score-changed",
          replyText: s.hq_score_changed({ redLabel, yellowLabel, red, yellow, oldRed: previous.red, oldYellow: previous.yellow }),
        }
      : { outcome: "hq-score-saved", replyText: s.hq_score_saved({ redLabel, red, yellow, yellowLabel }) };
  } else if (o.reply && o.askedWhichTeam) {
    await recordQuestion({ orgId, askRef: scoreAskRef(played.id), text: o.reply, now });
    scoreSaid = { outcome: "hq-score-asked", replyText: o.reply };
  } else if (o.reply) {
    scoreSaid = { outcome: "hq-score-not-changed", replyText: o.reply };
  }
  if (!organisersPickMom(state.features)) return scoreSaid;

  // The organisers pick Man of the Match. A message that names only the
  // player says nothing about the result: the engine's words on it (it
  // found no score) are not this message's answer.
  const scorePart = o.statesResult || !o.momRef ? scoreSaid : null;
  const momPart = await hqMom({
    ...input,
    matchId: played.id,
    momRef: o.momRef,
    scoreJustSaved: !!o.recorded && !o.recorded.previous,
    mom: input.deps?.mom ?? momPickDeps,
  });
  if (!momPart) return scorePart;
  // The tick goes on whatever was recorded: the score, else the player.
  const landed = (x: string) => ["hq-score-saved", "hq-score-changed", "hq-mom-saved", "hq-mom-changed"].includes(x);
  const said = scorePart
    ? {
        outcome: landed(scorePart.outcome) || !landed(momPart.outcome) ? scorePart.outcome : momPart.outcome,
        replyText: [scorePart.replyText, momPart.replyText].filter(Boolean).join(" "),
      }
    : { outcome: momPart.outcome, replyText: momPart.replyText };
  // A question about the player is filed under its own ref with the words
  // actually posted, so a WhatsApp reply quoting them is known as its answer.
  if (momPart.asked) await recordQuestion({ orgId, askRef: momAskRef(played.id), text: said.replyText, now });
  return said;
}

/**
 * Man of the Match from an organisers' message in HQ: recorded, asked
 * about once, or refused. Null when there is nothing to say about it.
 */
async function hqMom(
  a: HqScoreInput & {
    matchId: string;
    momRef: string | null;
    scoreJustSaved: boolean;
    mom: MomPickDeps;
  },
): Promise<{ outcome: string; replyText: string; asked?: true } | null> {
  const { lang, messageId, matchId } = a;
  const s = t(lang);
  if (!a.momRef) {
    // The score has just been saved and nobody named the player: ask once.
    if (!a.scoreJustSaved || (await a.mom.current(matchId)).length > 0) return null;
    return { outcome: "hq-mom-asked", replyText: s.hq_mom_ask({ mvpLabel: await a.mom.mvpLabel(matchId) }), asked: true };
  }
  const mvpLabel = await a.mom.mvpLabel(matchId);
  if (!a.organiser || !a.senderUserId) return { outcome: "hq-mom-organisers-only", replyText: s.hq_mom_organisers_only({ mvpLabel }) };
  const r = resolveMomRef(a.momRef, await a.mom.players(matchId));
  if (r.kind !== "resolved") {
    const text =
      r.kind === "ambiguous"
        ? s.hq_mom_which({ mvpLabel, ref: r.ref, choices: joinChoice(lang, r.names) })
        : s.hq_mom_not_in_match({ mvpLabel, ref: r.ref });
    console.log(`[admin-group] ${messageId}: man of the match ${r.kind}; asked`);
    return { outcome: "hq-mom-asked", replyText: text, asked: true };
  }
  const before = await a.mom.current(matchId);
  try {
    await a.mom.set({ matchId, playerId: r.userId, byUserId: a.senderUserId });
  } catch (err) {
    console.error(`[admin-group] ${messageId}: man of the match not saved:`, err instanceof Error ? err.message : "failed");
    return { outcome: "hq-mom-failed", replyText: s.hq_mom_failed({ mvpLabel }) };
  }
  console.log(`[admin-group] ${messageId}: man of the match set on ${matchId}`);
  const old = before.filter((b) => b.userId !== r.userId).map((b) => b.name);
  return old.length > 0
    ? { outcome: "hq-mom-changed", replyText: s.hq_mom_changed({ mvpLabel, name: r.name, old: old.join(", ") }) }
    : { outcome: "hq-mom-saved", replyText: s.hq_mom_saved({ mvpLabel, name: r.name }) };
}

/**
 * What the router is shown and told about the score in HQ: the score
 * MatchTime is waiting for (a context line), and the messages that go to
 * `score` whatever the model says (`scoreRouteOverrides`, the players'
 * group's own rule). Never fails HQ: a read error means nothing waits.
 */
export async function hqScoreRouting(args: {
  orgId: string;
  lang: string | null;
  messageId: string;
  body: string;
  addressed: boolean;
  senderUserId: string | null;
  now: Date;
  /** The organisers pick Man of the Match (mom-chooser.ts): it waits too. */
  momByOrganisers?: boolean;
}): Promise<{ waiting: ScoreWaiting | null; scoreAnswerIds: Set<string>; scoreCorrectionIds: Set<string> }> {
  const { orgId, now } = args;
  const [ask, unscored, momMissing, overrides] = await Promise.all([
    loadOpenScoreAsk(orgId, now).catch(() => null),
    loadUnscoredPlayedMatch(orgId, now).catch(() => null),
    args.momByOrganisers ? loadMomMissing(orgId, now).catch(() => null) : Promise.resolve(null),
    scoreRouteOverrides(orgId, [{ id: args.messageId, body: args.body, tagged: args.addressed, senderUserId: args.senderUserId }], now).catch(
      () => ({ scoreAnswerIds: new Set<string>(), scoreCorrectionIds: new Set<string>() }),
    ),
  ]);
  const waiting: ScoreWaiting | null = ask
    ? { kind: "which-team", first: ask.first, second: ask.second, labels: ask.labels, askedAt: ask.askedAt }
    : unscored
      ? {
          kind: "result",
          day: dayLabel(args.lang, unscored.date),
          labels: unscored.labels,
          ...(momMissing?.matchId === unscored.matchId ? { mom: true } : {}),
        }
      : momMissing
        ? { kind: "mom", day: dayLabel(args.lang, momMissing.date) }
        : null;
  return { waiting, ...overrides };
}

/**
 * The latest played match, inside the score window, with no Man of the
 * Match recorded: what an organisers' club is still to be asked for.
 */
async function loadMomMissing(orgId: string, now: Date): Promise<{ matchId: string; date: Date } | null> {
  const latest = await latestPlayedMatch(orgId, now);
  if (!latest || now.getTime() - latest.date.getTime() > SCORE_CORRECTION_WINDOW_MS) return null;
  const any = await db.moMVote.findFirst({ where: { matchId: latest.matchId }, select: { id: true } });
  return any ? null : { matchId: latest.matchId, date: latest.date };
}
