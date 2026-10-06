/**
 * LIVE CHECK: the rewritten score extractor, each case ONCE.
 *
 * ⚠️  THIS CALLS THE REAL MODEL AND COSTS MONEY. DO NOT RUN IT WITHOUT
 *     KEMAL'S APPROVAL FOR THIS SPECIFIC RUN (CLAUDE.md, 2026-09-19).
 *     It was written on 2026-10-07 and NOT run.
 *
 * WHY. The score extractor prompt was rewritten whole when it became
 * team-aware (Sutton FC, 2026-10-06: "9-6 to yellows" recorded as Red 9,
 * Yellow 6). A rewrite widens the regression risk, so the check covers
 * every behaviour the old prompt handled (the club's own history of
 * result messages) as well as the new ones. The cases, and what each is
 * there to prove, are in `src/lib/pipeline/score-live-cases.ts`.
 *
 * WHAT IT GRADES. The OUTCOME: the extracted facts are passed through
 * the real team resolver (`score-teams.ts`) and must land on the stated
 * result, or on "ask". Not the exact wording of a team field: "Yellows"
 * and "yellows" are the same answer. Plus the `correction` flag.
 *
 * COST. 26 cases x 1 call on claude-sonnet-5, thinking off. About 1,500
 * input tokens (a ~2,900 character prompt, the schema, a short message)
 * and about 70 output tokens each: roughly $0.004 a call, about $0.10
 * for the pass. The real total is printed.
 *
 *   ROUTER=1 also asks the real ROUTER (claude-haiku-4-5, prompt
 *   unchanged by this work) where it sends each message, one batch per
 *   case: 26 more calls, about $0.004 each, about $0.10 more. Worth one
 *   pass because a correction only reaches the extractor if the router
 *   calls it `score`, and nothing has ever measured that for "no it was
 *   9-7" or the Turkish forms.
 *
 * WHAT ONE PASS CANNOT PROVE. An occasional miss (a case the model gets
 * right nine times in ten) can pass once and fail live. It would show up
 * in the group as a question ("9 - 6 to which team?") or a wrong result
 * that the reply states winner first, where it can be corrected.
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
import { resolveScoreResult } from "../src/lib/pipeline/score-teams.ts";
import { SCORE_LIVE_CASES } from "../src/lib/pipeline/score-live-cases.ts";

async function main() {
  spendDevApiKeyOrExit("scripts/live-check-score-extractor.ts");
  const model = anthropicModel();
  const only = (process.env.ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const cases = only.length ? SCORE_LIVE_CASES.filter((c) => only.includes(c.id)) : SCORE_LIVE_CASES;
  const withRouter = process.env.ROUTER === "1";

  let calls = 0;
  let usd = 0;
  let failed = 0;

  // One at a time: 26 calls is seconds, and a serial run keeps the
  // output in case order.
  for (const c of cases) {
    const author = "Kemal Ediz";
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
      const r = resolveScoreResult({
        facts: res.facts,
        labels: c.labels ?? ["Red", "Yellow"],
        senderTeam: c.senderTeam ?? null,
      });
      got = r.kind === "resolved" ? `Red ${r.red}, Yellow ${r.yellow}` : `ask (${r.why})`;
      const want = c.expect === "ask" ? "ask" : `Red ${c.expect.red}, Yellow ${c.expect.yellow}`;
      const outcomeOk =
        c.expect === "ask" ? r.kind === "ask" : r.kind === "resolved" && r.red === c.expect.red && r.yellow === c.expect.yellow;
      if (!outcomeOk) problems.push(`wanted ${want}`);
      if ((res.facts.correction ?? false) !== (c.correction ?? false)) {
        problems.push(`correction flag ${res.facts.correction ?? false}, wanted ${c.correction ?? false}`);
      }
    }

    let route = "";
    if (withRouter) {
      const rr = await routeBatch(model, [{ id: c.id, authorName: author, body: c.body }]);
      calls++;
      usd += rr.usage?.costUsd ?? 0;
      const to = rr.routes[0]?.route ?? "?";
      route = `  route=${to}`;
      if (to !== "score") problems.push(`router sent it to "${to}", so the extractor would never see it`);
    }

    if (problems.length) failed++;
    console.log(`${problems.length ? "FAIL" : "ok  "} ${c.id.padEnd(4)} ${JSON.stringify(c.body).slice(0, 70).padEnd(72)} -> ${got}${route}`);
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
