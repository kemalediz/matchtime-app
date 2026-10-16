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
 */
import { t } from "./i18n/t";
import { dayLabel } from "./i18n/dates";
import { buildScoreApplyDeps } from "./owner-deps";
import { runScoreBatch } from "./score-engine-batch";
import type { ScoreApplyDeps } from "./score-engine";
import { enabledStepSevenRoutes } from "./pipeline/route-flags";
import { statesSeveralScorelines } from "./pipeline/score-ask";
import { loadOpenScoreAsk, loadUnscoredPlayedMatch, scoreRouteOverrides } from "./pipeline/load-awaiting-answer";
import type { PipelineModel } from "./pipeline/llm";
import type { SquadState } from "./pipeline/types";
import { recordMatchTimeQuestion } from "./admin-group-log";
import type { ScoreWaiting } from "./admin-group-context";

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
  if (o.recorded) {
    const { red, yellow, previous } = o.recorded;
    console.log(`[admin-group] ${messageId}: score ${previous ? "changed" : "saved"} on ${o.matchId} (${o.eloApplied} rating(s) moved)`);
    return previous
      ? {
          outcome: "hq-score-changed",
          replyText: s.hq_score_changed({ redLabel, yellowLabel, red, yellow, oldRed: previous.red, oldYellow: previous.yellow }),
        }
      : { outcome: "hq-score-saved", replyText: s.hq_score_saved({ redLabel, red, yellow, yellowLabel }) };
  }
  if (!o.reply) return null;
  if (o.askedWhichTeam) {
    await recordQuestion({ orgId, askRef: scoreAskRef(played.id), text: o.reply, now });
    return { outcome: "hq-score-asked", replyText: o.reply };
  }
  return { outcome: "hq-score-not-changed", replyText: o.reply };
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
}): Promise<{ waiting: ScoreWaiting | null; scoreAnswerIds: Set<string>; scoreCorrectionIds: Set<string> }> {
  const { orgId, now } = args;
  const [ask, unscored, overrides] = await Promise.all([
    loadOpenScoreAsk(orgId, now).catch(() => null),
    loadUnscoredPlayedMatch(orgId, now).catch(() => null),
    scoreRouteOverrides(orgId, [{ id: args.messageId, body: args.body, tagged: args.addressed, senderUserId: args.senderUserId }], now).catch(
      () => ({ scoreAnswerIds: new Set<string>(), scoreCorrectionIds: new Set<string>() }),
    ),
  ]);
  const waiting: ScoreWaiting | null = ask
    ? { kind: "which-team", first: ask.first, second: ask.second, labels: ask.labels, askedAt: ask.askedAt }
    : unscored
      ? { kind: "result", day: dayLabel(args.lang, unscored.date), labels: unscored.labels }
      : null;
  return { waiting, ...overrides };
}
