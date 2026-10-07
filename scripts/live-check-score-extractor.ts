/**
 * LIVE CHECK: the rewritten score extractor, each case ONCE.
 *
 * ⚠️  THIS CALLS THE REAL MODEL AND COSTS MONEY. DO NOT RUN IT WITHOUT
 *     KEMAL'S APPROVAL FOR THIS SPECIFIC RUN (CLAUDE.md, 2026-09-19).
 *     It was written on 2026-10-07 and NOT run.
 *
 * WHY. The score extractor prompt was rewritten whole, twice: when it
 * became team-aware (Sutton FC, 2026-10-06: "9-6 to yellows" recorded as
 * Red 9, Yellow 6), and again after the review of PR #214 (no numbers is
 * not 0-0, a lone team name is not a winner, a tag is not a correction).
 * The second review changed CODE rules only (a recorded result changes
 * only for a TAGGED correction; the open question takes a narrow
 * answer), so the prompt is as it was and the expected outcomes moved.
 * A rewrite widens the regression risk, so the check covers every
 * behaviour the old prompt handled (the club's own history of result
 * messages) as well as the new ones. The cases, and what each is there
 * to prove, are in `src/lib/pipeline/__tests__/score-live-cases.ts`.
 *
 * WHAT IT GRADES. The OUTCOME. The extracted facts go through the real
 * engine over the case's world (`runScoreCase`) and must produce what
 * the case says: a recorded result, the bot asking which team won, the
 * bot saying what is already recorded, or nothing. Not the wording of a
 * team field: "Yellows" and "yellows" are the same answer.
 *
 * COST. 47 cases x 1 call on claude-sonnet-5, thinking off. About 1,900
 * input tokens (a ~4,000 character prompt, the schema, a short message)
 * and about 90 output tokens each: roughly $0.0045 a call, about $0.21
 * for the pass. The real total is printed.
 *
 *   ROUTER=1 also asks the real ROUTER (claude-haiku-4-5, prompt
 *   unchanged by this work) where it sends each message, one batch per
 *   case: 47 more calls, about $0.004 each, about $0.19 more ($0.40 in
 *   all). Worth one pass, because a message only reaches the extractor
 *   if the router calls it `score`, and nothing has ever measured that
 *   for "no it was 9-7", "wrong way round, yellows won" or the Turkish
 *   forms. Where a question is open and the message qualifies as its
 *   answer (`isScoreAnswer`), the router is handed its id, as it is in
 *   production.
 *
 * WHAT ONE PASS CANNOT PROVE. An occasional miss (a case the model gets
 * right nine times in ten) can pass once and fail live. It would show up
 * in the group as a question ("9 - 6: which team won?") or as a result
 * stated winner first, where it can be corrected.
 *
 * ZERO WRITES, structurally: no database client is imported.
 *
 *   node --env-file=.env ./node_modules/.bin/tsx scripts/live-check-score-extractor.ts
 *   ROUTER=1 node --env-file=.env ./node_modules/.bin/tsx scripts/live-check-score-extractor.ts
 *   ONLY=I1,I2 node --env-file=.env ./node_modules/.bin/tsx scripts/live-check-score-extractor.ts
 */
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { extractForRoute } from "../src/lib/pipeline/extractors.ts";
import { routeBatch } from "../src/lib/pipeline/router.ts";
import { anthropicModel } from "../src/lib/pipeline/llm.ts";
import {
  isScoreAnswer,
  isScoreCorrectionText,
  scoreAnswerSide,
  scorePairAnswerSide,
} from "../src/lib/pipeline/score-ask.ts";
import {
  SCORE_LIVE_CASES,
  describeOutcome,
  runScoreCase,
} from "../src/lib/pipeline/__tests__/score-live-cases.ts";

async function main() {
  spendDevApiKeyOrExit("scripts/live-check-score-extractor.ts");
  const model = anthropicModel();
  const only = (process.env.ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const cases = only.length ? SCORE_LIVE_CASES.filter((c) => only.includes(c.id)) : SCORE_LIVE_CASES;
  const withRouter = process.env.ROUTER === "1";

  let calls = 0;
  let usd = 0;
  let failed = 0;

  // One at a time: a few dozen calls is seconds, and a serial run keeps
  // the output in case order.
  for (const c of cases) {
    const author = c.sender === "yellow" ? "Najib" : "Kemal Ediz";
    const res = await extractForRoute(model, "score", {
      id: c.id,
      body: c.body,
      authorName: author,
      tagged: c.tagged ?? false,
      history: [],
      lastBotPost: c.lastBotPost ?? null,
    });
    calls++;
    usd += res.usage?.costUsd ?? 0;

    const problems: string[] = [];
    let got = "no score facts";
    if (res.facts.kind !== "score") {
      problems.push(`extractor returned "${res.facts.kind}" (${res.degradations.map((d) => d.detail).join("; ")})`);
    } else {
      const outcome = runScoreCase(c, res.facts);
      got = describeOutcome(outcome);
      if (JSON.stringify(outcome) !== JSON.stringify(c.expect)) problems.push(`wanted ${describeOutcome(c.expect)}`);
    }

    let route = "";
    if (withRouter) {
      // As the analyze route does: decide, without a model, whether
      // this message answers the open question, and hand the router
      // its id if so.
      const senderUserId = c.sender === "yellow" ? "u-najib" : "u-kemal";
      const isAnswer =
        !!c.pending &&
        !c.recorded &&
        (scoreAnswerSide(c.body, c.labels ?? ["Red", "Yellow"]) !== null ||
          scorePairAnswerSide(c.body, c.pending, c.labels ?? ["Red", "Yellow"]) !== null) &&
        isScoreAnswer({
          body: c.body,
          tagged: c.tagged ?? false,
          senderUserId,
          senderIsAdmin: c.sender !== "yellow",
          ask: {
            askedAt: new Date(Date.now() - 60_000),
            askerUserId: c.pending.askedBy === "yellow" ? "u-najib" : "u-kemal",
          },
          now: new Date(),
        });
      // And, as the analyze route does, whether it is a tagged
      // correction of a recorded result by its words alone
      // (`isScoreCorrectionText`). The first run of this script
      // (2026-10-07, 94 calls, $0.4118, 45 of 47) failed X2 and T6 on
      // exactly this: the router sent them to `unsure` and `other_att`.
      // They no longer depend on the router at all.
      const isCorrection =
        (c.tagged ?? false) && !!c.recorded && isScoreCorrectionText(c.body, c.labels ?? ["Red", "Yellow"]);
      const rr = await routeBatch(model, [{ id: c.id, authorName: author, body: c.body }], {
        scoreAnswerIds: new Set(isAnswer ? [c.id] : []),
        scoreCorrectionIds: new Set(isCorrection ? [c.id] : []),
      });
      calls++;
      usd += rr.usage?.costUsd ?? 0;
      const to = rr.routes[0]?.route ?? "?";
      route = `  route=${to}`;
      if (to !== "score" && !c.anyRoute) {
        problems.push(`router sent it to "${to}", so the score route would never see it`);
      }
    }

    if (problems.length) failed++;
    console.log(
      `${problems.length ? "FAIL" : "ok  "} ${c.id.padEnd(4)} ${JSON.stringify(c.body).slice(0, 70).padEnd(72)} -> ${got}${route}` +
        (c.noModelInProduction ? "  (read without the model in production)" : ""),
    );
    if (res.facts.kind === "score") console.log(`       facts ${JSON.stringify(res.facts)}`);
    for (const p of problems) console.log(`       ${p}  [${c.why}]`);
  }

  console.log(`\n${cases.length - failed}/${cases.length} cases passed. ${calls} model call(s), $${usd.toFixed(4)}.`);
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
