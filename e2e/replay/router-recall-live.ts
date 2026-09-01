/**
 * ROUTER RECALL, LIVE — routes all 1,723 production messages through the
 * real router and reports what it would have thrown away.
 *
 *   npm run replay:extract               # once, READ-ONLY against prod
 *   npm run replay:router-recall         # floor OFF — the router's own recall
 *   MT_RECALL_FLOOR=1 npm run replay:router-recall   # floor ON
 *
 * Writes `.e2e/replay/router-recall-<floor|nofloor>.json` alongside the
 * printed report.
 *
 * WHY THIS IS NOT A PLAYWRIGHT SPEC. It needs no server, no database and
 * no analyze route: the router is a pure function of a message list, and
 * the extract is on disk. A spec would drag in the whole harness to
 * measure one call.
 *
 * IT STILL HAS TO PROVE IT WAS LIVE. PR #38's rule is that a sweep which
 * cannot reach the model FAILS rather than reporting a flattering
 * number — and a keyless run here is exactly as flattering as the
 * keyless corpus run that scored 8/47 in four seconds: `routeBatch`
 * catches the error and falls back to routing everything `unsure`, which
 * reads as a perfect 0% miss rate. So this script:
 *
 *   1. refuses without a usable ANTHROPIC_API_KEY;
 *   2. spends one token proving the EXACT router model is reachable;
 *   3. counts every call and every fallback route, and FAILS if the
 *      model was never reached or if the fallback rate is high enough
 *      that the answer is really the fallback's, not the router's;
 *   4. prints a `LIVE confirmed` line in the same shape the corpus and
 *      replay sweeps print, to be quoted alongside the number.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config as loadEnv } from "dotenv";
import { keyFingerprint, probeAnthropic } from "../helpers/live-llm";
import { anthropicModel, ROUTER_MODEL } from "../../src/lib/pipeline/llm";
import { routeBatch } from "../../src/lib/pipeline/router";
import { batchMessages, groupRefOf } from "./reconstruct";
import { floorForcesAnalysis } from "../../src/lib/pipeline/gate";
import {
  deriveFloorEffect,
  renderFloorEffect,
  renderRecall,
  summariseRecall,
  toRoutedRow,
  type RoutedRow,
} from "./router-recall";
import type { ReplaySource } from "./types";

loadEnv();

const DIR = path.join(process.cwd(), ".e2e", "replay");
const SOURCE = path.join(DIR, "source.json");

/** Above this share of `fallback` routes the report is the FALLBACK's
 *  answer, not the router's, and quoting it as recall would be a
 *  fabricated measurement. */
const MAX_FALLBACK_RATE = 0.05;

async function main(): Promise<number> {
  const floor = process.env.MT_RECALL_FLOOR === "1";
  const capped = Number(process.env.MT_RECALL_LIMIT ?? "") > 0;
  const label = `${floor ? "floor ON" : "floor OFF"}${capped ? " · PARTIAL RUN" : ""}`;

  const key = (process.env.ANTHROPIC_API_KEY ?? "").trim();
  if (!key) {
    console.error(
      `[recall] REFUSING to run — ANTHROPIC_API_KEY is empty.\n` +
        `  routeBatch catches a failed call and routes the whole batch \`unsure\`, so a\n` +
        `  keyless run would report a perfect 0% miss rate and prove nothing. That is the\n` +
        `  same defect PR #38 fixed in the corpus and replay sweeps.\n` +
        `  Fix:  set -a; source .env; set +a`,
    );
    return 1;
  }

  let source: ReplaySource;
  try {
    source = JSON.parse(readFileSync(SOURCE, "utf8")) as ReplaySource;
  } catch {
    console.error(`[recall] no extract at ${SOURCE}. Run \`npm run replay:extract\` first.`);
    return 1;
  }

  // (2) — one token, against the model the router ACTUALLY uses. Not a
  // proxy for it: `PROBE_MODEL` is the analyzer's Sonnet, and a key with
  // Sonnet access but no Haiku access would sail through that and then
  // fall back on every batch here.
  const probe = await probeAnthropic({ key, model: ROUTER_MODEL });
  console.log(
    `[recall] LLM: LIVE — probe OK. ${probe.model} answered in ${probe.ms}ms and billed ` +
      `${probe.inputTokens} in / ${probe.outputTokens} out tokens to key ${probe.fingerprint}.`,
  );

  const withBody = source.messages.filter((m) => (m.body ?? "").trim().length > 0);
  const all = batchMessages(withBody);
  // MT_RECALL_LIMIT caps the run for a smoke test. A capped run says so
  // on every line of its own report so it can never be quoted as the
  // full sweep.
  const limit = Number(process.env.MT_RECALL_LIMIT ?? "") || 0;
  const batches = limit > 0 ? all.slice(0, limit) : all;
  if (limit > 0) {
    console.log(
      `[recall] ⚠️  PARTIAL RUN — capped at ${limit} of ${all.length} batches by ` +
        `MT_RECALL_LIMIT. Not the full sweep; do not quote as one.`,
    );
  }
  console.log(
    `[recall] ${withBody.length} of ${source.messages.length} messages have a body, in ` +
      `${batches.length} recovered batches. Routing with the ${label}.`,
  );

  const model = anthropicModel({ apiKey: key });
  const rows: RoutedRow[] = [];
  let costUsd = 0;
  let ms = 0;
  let calls = 0;
  let fallbacks = 0;

  for (let i = 0; i < batches.length; i++) {
    const b = batches[i];
    const res = await routeBatch(
      model,
      b.messages.map((m) => ({
        id: m.waMessageId,
        authorName: m.authorName,
        body: m.body ?? "",
      })),
      { floor },
    );
    if (res.usage) {
      calls += 1;
      costUsd += res.usage.costUsd ?? 0;
      ms += res.usage.ms;
    }
    const byId = new Map(res.routes.map((r) => [r.messageId, r]));
    for (const m of b.messages) {
      const r = byId.get(m.waMessageId);
      if (r?.source === "fallback") fallbacks += 1;
      rows.push(
        toRoutedRow(m, groupRefOf(m.groupId), {
          route: r?.route ?? "unsure",
          source: r?.source ?? "fallback",
        }),
      );
    }
    if ((i + 1) % 25 === 0 || i === batches.length - 1) {
      console.log(
        `[recall]   ${i + 1}/${batches.length} batches · ${rows.length} messages · ` +
          `$${costUsd.toFixed(4)}`,
      );
    }
  }

  // (3) — the guard. Zero calls is a failure whatever the numbers say.
  if (calls === 0) {
    console.error(
      `[recall] REFUSING to report — not one router call was billed across ` +
        `${batches.length} batches. Every route came from the fallback, so this measures ` +
        `the fallback, not the router.`,
    );
    return 1;
  }
  const fallbackRate = rows.length === 0 ? 1 : fallbacks / rows.length;
  const report = summariseRecall(rows);

  console.log("");
  console.log(renderRecall(report, { label, costUsd, ms, calls, batches: batches.length }));
  // On a floor-OFF run, derive what the floor WOULD have done to these
  // exact answers. Two paid sweeps answer it badly: half the difference
  // between them is the model changing its mind. This isolates the
  // floor, costs nothing, and is reproducible from the stored run.
  const derived = floor ? null : deriveFloorEffect(rows, report, floorForcesAnalysis);
  if (derived) {
    console.log("");
    console.log(renderFloorEffect(derived, report));
  }
  console.log("");
  console.log(
    `[recall] LLM: LIVE confirmed - ${calls} router call(s) billed: ` +
      `$${costUsd.toFixed(4)} across ${ROUTER_MODEL}, key ${keyFingerprint(key)}. ` +
      `${rows.length - fallbacks} of ${rows.length} routes came from the model ` +
      `(${(fallbackRate * 100).toFixed(1)}% fallback).`,
  );

  mkdirSync(DIR, { recursive: true });
  const out = path.join(DIR, `router-recall-${floor ? "floor" : "nofloor"}.json`);
  writeFileSync(
    out,
    JSON.stringify(
      {
        label,
        floor,
        model: ROUTER_MODEL,
        at: new Date().toISOString(),
        calls,
        costUsd,
        modelMs: ms,
        batches: batches.length,
        fallbackRate,
        report,
        derivedFloor: derived,
        rows,
      },
      null,
      2,
    ),
  );
  console.log(`[recall] wrote ${out}`);

  if (fallbackRate > MAX_FALLBACK_RATE) {
    console.error(
      `[recall] REFUSING to pass — ${(fallbackRate * 100).toFixed(1)}% of routes came from the ` +
        `fallback (limit ${(MAX_FALLBACK_RATE * 100).toFixed(0)}%). The report above is written ` +
        `to disk for triage, but the recall number in it is not the router's.`,
    );
    return 1;
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("[recall] failed:", err);
    process.exit(1);
  });
