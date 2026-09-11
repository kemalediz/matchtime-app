/**
 * THE METRIC WITH A VETO — of every hand-labelled attendance message in
 * the production extract, how many does the router call banter?
 *
 *   npm run replay:router-attendance                 # 3 live runs
 *   MT_ATT_REPEATS=5 npm run replay:router-attendance
 *
 * `gate.ts`: *"Missing a saving costs pennies. Missing a player's IN
 * costs them their place."* This is the number that sentence is about,
 * and `MDs/router-accuracy-2026-09-11.md` §3.1 is why it is a script
 * and not a paragraph: a candidate prompt scored HIGHER on overall
 * accuracy while TRIPLING this, and a held-out split did not catch it.
 * A prompt change is cleared here or it is not cleared.
 *
 * THREE RUNS, NOT ONE, and the reason is measured: §1.6 found the
 * baseline losing three, two and four across three live runs of the
 * same corpus. One run cannot tell a two-message improvement from the
 * model having a different afternoon. It also separates the two failure
 * shapes that matter — a message lost in ONE run of three is sampling,
 * and one lost in all three is a prompt gap with a name.
 *
 * THE BATCH IS KEPT WHOLE. Only batches containing at least one
 * attendance message are routed (294 of 974 on the 2026-09-11 extract),
 * but each is routed with all of its real neighbours, because the
 * router reasons over the whole flush and a message sitting alone is a
 * batch production never sent.
 *
 * ── THE GOLD SET IS NOT IN GIT ───────────────────────────────────────
 *
 * `.e2e/replay/gold.json` maps a lower-cased, trimmed message body to
 * the owner it must reach:
 *
 *     { "<body>": { "gold": "A" | "N" | "Q" | "B" | "S" | "D" | "A|B",
 *                   "stratum": "nonbenign" | "benign" } }
 *
 * It is 445 real messages from a real club, so it lives under `.e2e/`
 * with the extract itself rather than in the repository — same rule as
 * `source.json`, and `README.md`'s privacy section is the argument. A
 * checkout without one is told how to get one rather than being given a
 * flattering zero.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { config as loadEnv } from "dotenv";
import { probeAnthropic } from "../helpers/live-llm";
import { anthropicModel, ROUTER_MODEL } from "../../src/lib/pipeline/llm";
import { routeBatch } from "../../src/lib/pipeline/router";
import { batchMessages } from "./reconstruct";
import type { ReplaySource } from "./types";

loadEnv();

const DIR = path.join(process.cwd(), ".e2e", "replay");
const SOURCE = path.join(DIR, "source.json");
const GOLD = path.join(DIR, "gold.json");

interface GoldEntry {
  gold: string;
  stratum?: string;
}

async function main(): Promise<number> {
  const key = (process.env.ANTHROPIC_API_KEY ?? "").trim();
  if (!key) {
    console.error(
      `[att] REFUSING to run — ANTHROPIC_API_KEY is empty.\n` +
        `  routeBatch routes a failed call \`unsure\`, never \`none\`, so a keyless run\n` +
        `  reports a perfect 0 of 373 in under a minute and proves nothing.\n` +
        `  Fix:  set -a; source .env; set +a`,
    );
    return 1;
  }

  let source: ReplaySource;
  try {
    source = JSON.parse(readFileSync(SOURCE, "utf8")) as ReplaySource;
  } catch {
    console.error(`[att] no extract at ${SOURCE}. Run \`npm run replay:extract\` first.`);
    return 1;
  }

  let gold: Record<string, GoldEntry>;
  try {
    gold = JSON.parse(readFileSync(GOLD, "utf8")) as Record<string, GoldEntry>;
  } catch {
    console.error(
      `[att] no gold set at ${GOLD}.\n` +
        `  This measurement is scored against hand labels, not against production's own\n` +
        `  \`intent\` column — §1.2 shows why that column reads a real IN mislabelled\n` +
        `  \`noise\` as THE SAVING. Without labels there is nothing to measure, and\n` +
        `  reporting anything here would be a fabricated number.\n` +
        `  See the header of this file for the shape; it is kept out of git with the extract.`,
    );
    return 1;
  }

  const isA = (body: string | null): boolean => {
    const g = gold[(body ?? "").trim().toLowerCase()];
    return !!g && g.gold.split("|").includes("A");
  };

  const withBody = source.messages.filter((m) => (m.body ?? "").trim().length > 0);
  const all = batchMessages(withBody);
  const batches = all.filter((b) => b.messages.some((m) => isA(m.body)));
  const population = batches.reduce(
    (n, b) => n + b.messages.filter((m) => isA(m.body)).length,
    0,
  );
  if (population === 0) {
    console.error(`[att] the gold set matched nothing in this extract. Refusing to report 0 of 0.`);
    return 1;
  }

  const repeats = Math.max(1, Number(process.env.MT_ATT_REPEATS ?? 3));
  const probe = await probeAnthropic({ key, model: ROUTER_MODEL });
  console.log(
    `[att] LLM: LIVE — probe OK. ${probe.model} answered in ${probe.ms}ms and billed ` +
      `${probe.inputTokens} in / ${probe.outputTokens} out tokens to key ${probe.fingerprint}.`,
  );
  console.log(
    `[att] ${batches.length} of ${all.length} batches carry a gold-attendance message; ` +
      `${population} such messages. ${repeats} live run(s), floor OFF.`,
  );

  const model = anthropicModel({ apiKey: key });
  const lostRuns = new Map<string, number>();
  const perRun: number[] = [];
  let cost = 0;
  let calls = 0;
  let fallbacks = 0;

  for (let rep = 0; rep < repeats; rep++) {
    let lost = 0;
    let seen = 0;
    for (const b of batches) {
      const res = await routeBatch(
        model,
        b.messages.map((m) => ({
          id: m.waMessageId,
          authorName: m.authorName,
          body: m.body ?? "",
        })),
        { floor: false, awaiting: null },
      );
      if (res.usage) {
        calls += 1;
        cost += res.usage.costUsd ?? 0;
      }
      const by = new Map(res.routes.map((r) => [r.messageId, r]));
      for (const m of b.messages) {
        if (!isA(m.body)) continue;
        seen += 1;
        const r = by.get(m.waMessageId);
        if (r?.source === "fallback") fallbacks += 1;
        if (r?.route === "none") {
          lost += 1;
          const body = (m.body ?? "").replace(/\n/g, " ");
          lostRuns.set(body, (lostRuns.get(body) ?? 0) + 1);
        }
      }
    }
    perRun.push(lost);
    console.log(`[att]   run ${rep + 1}/${repeats}: ${lost} of ${seen} routed none · $${cost.toFixed(3)}`);
  }

  if (calls === 0 || fallbacks > 0) {
    console.error(
      `[att] REFUSING to report — ${calls} billed calls and ${fallbacks} fallback routes. ` +
        `A fallback is \`unsure\`, which never counts as lost, so the number would flatter.`,
    );
    return 1;
  }

  const mean = perRun.reduce((a, b) => a + b, 0) / perRun.length;
  console.log("");
  console.log(`ATTENDANCE ROUTED none, ${repeats} live runs of ${population} messages:`);
  console.log(`  per run: ${perRun.join(", ")}   mean ${mean.toFixed(1)} of ${population}`);
  if (lostRuns.size === 0) {
    console.log(`  nothing lost, in any run.`);
  } else {
    console.log("");
    console.log(`  lost (runs / ${repeats}):`);
    for (const [body, runs] of [...lostRuns.entries()].sort((a, b) => b[1] - a[1])) {
      const shape = runs === repeats ? "PROMPT GAP — same message every run" : "sampling";
      console.log(`    ${runs}/${repeats}  ${shape}  ${JSON.stringify(body.slice(0, 110))}`);
    }
  }
  console.log("");
  console.log(
    `[att] LIVE confirmed — ${calls} billed ${ROUTER_MODEL} calls, $${cost.toFixed(4)}, ` +
      `0 fallbacks, key ${probe.fingerprint}.`,
  );
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
