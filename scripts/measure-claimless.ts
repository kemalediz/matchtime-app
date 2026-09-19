/**
 * ═══════════════════════════════════════════════════════════════════════
 * MEASURE THE CLAIMLESS RATE — how often the live attendance extractor
 * reads a plain self-attendance message and returns NO CLAIM AT ALL.
 * ═══════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS. On 2026-09-09 four players typed the single word "In"
 * for the Tuesday match inside twenty minutes. Two were registered and
 * two were silently discarded:
 *
 *   19:37:58  Wasim   "In"  -> intent=in    action=IN
 *   19:47:55  Abid    "In"  -> intent=noise action=none
 *   19:57:58  Mojib   "In"  -> intent=noise action=none
 *   19:57:59  habib   "In"  -> intent=in    action=IN
 *
 * Mojib and habib are ONE SECOND apart, in the SAME batch, with the same
 * word and opposite outcomes. The two that died came back from the
 * extractor as `claims: []` with `affirmation: "yes"` — read as a bare
 * answer to MatchTime's last post rather than as the sender's own claim
 * about themselves. `engine.ts` then had nowhere to put them.
 *
 * A bare affirmative is the single most common message this product
 * receives. A distribution is the only honest description of what a
 * model does with one, so the fix has to be MEASURED, not asserted.
 * This script is that measurement: it calls the REAL extractor with the
 * REAL prompt, N times per phrasing, and reports "N of M came back
 * claimless".
 *
 * ── THE CONTEXT IS THE EXPERIMENT, AND IT IS NOT THE BOT'S LAST POST ──
 * The first cut of this script varied `MATCHTIME'S LAST POST` and got
 * 0 of 20 claimless on every phrasing, in all three of a fresh roster, a
 * 26-hour-stale team sheet and nothing at all — 420 calls that
 * reproduced nothing. The reproducing variable is the RECENT CHAT, and
 * specifically a RUN OF IDENTICAL BARE AFFIRMATIVES in front of the
 * message. That is exactly the shape the live group had: the Pi buffers
 * the last 15 inbound messages, records each message into that buffer
 * BEFORE flushing it, and its process had restarted at 17:28, so by the
 * time Abid typed "In" the whole recent chat was other people typing
 * "In". A fifth "In" under four identical ones reads as an echo; the
 * first one does not. `CONTEXT` selects which of those two worlds the
 * measurement runs in.
 *
 * ── ZERO WRITES, structurally ─────────────────────────────────────────
 * There is no database client in this file. It imports the extractor and
 * the model and nothing else; it cannot read or write production data.
 *
 * ── IT COSTS REAL MONEY ───────────────────────────────────────────────
 * Every run is a real extractor call billed to the DEVELOPER's key,
 * ANTHROPIC_API_KEY_DEV, roughly $0.003 each. The default sweep is 16
 * phrasings x 20 runs = 320 calls, about $1. The total is printed.
 *
 * ── HOW TO RUN ────────────────────────────────────────────────────────
 *   node --env-file=.env ./node_modules/.bin/tsx scripts/measure-claimless.ts
 *
 *   RUNS=20         runs per phrasing (default 20). Twenty is the floor:
 *                   the live rate we are chasing is roughly one in six.
 *   CONTEXT=echo    the reconstructed incident: a run of bare "In"s in
 *                   front of the message (default).
 *   CONTEXT=quiet   an isolated affirmative, no run in front of it.
 *   CONTEXT=all     both.
 *   CONCURRENCY=8   parallel calls (default 8).
 *   ONLY="in,yes"   comma-separated subset of the phrasings.
 *   ROUTES=1        measure the ROUTER instead: the route distribution
 *                   for each phrasing. This is the other half of the
 *                   acceptance test — the engine's fallback for a
 *                   claimless affirmation keys on `self_att`, so "does a
 *                   bare 'yes' ever route self_att?" is the question
 *                   that decides whether the fallback is safe.
 * ═══════════════════════════════════════════════════════════════════════
 */
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { extractForRoute } from "../src/lib/pipeline/extractors.ts";
import { routeBatch } from "../src/lib/pipeline/router.ts";
import { anthropicModel } from "../src/lib/pipeline/llm.ts";
import type { AttendanceFacts } from "../src/lib/pipeline/types.ts";

/**
 * THE PHRASINGS. Kemal, on the fix: "not just in, anyone can say yes,
 * count me, sure. Many different words."
 *
 * So the set is deliberately wider than the incident. It splits in two,
 * and the split is the whole product question:
 *
 *   SELF-EVIDENT   the words themselves say the sender is playing. A
 *                  claim is the only correct extraction.
 *   BARE           the words affirm and name nothing. Whether they are
 *                  attendance is a fact about the CONVERSATION, not
 *                  about the word, and the extractor cannot see enough
 *                  to know. A claimless read here is CORRECT.
 *
 * Both are measured, because the fix must move the first group to zero
 * without dragging the second group with it.
 */
const SELF_EVIDENT = [
  "In",
  "in",
  "IN",
  "I'm in",
  "im in",
  "In for Tuesday",
  "count me in",
  "count me",
  "add me",
  "put me down",
  "I'll play",
  "I'm there",
  "yes im in",
];
const BARE = ["yes", "yep", "sure", "go on then", "👍", "ok"];
const PHRASINGS = [...SELF_EVIDENT, ...BARE];

/**
 * MatchTime's last post during the incident: the previous night's
 * kickoff correction and team sheet, 26 hours stale, recovered from the
 * `BotJob` table. It is the same in both contexts — it was measured as
 * NOT the reproducing variable (see the header) and is held fixed so the
 * recent chat is the only thing that moves.
 */
const LAST_BOT_POST =
  "⏰ *Correction — kickoff is 21:15 tonight, not 21:30.* The 5-a-side starts 15 minutes " +
  "earlier than the 7-a-side.\n\n⚽ *Teams for tonight* — 21:15 at Goals North Cheam\n\n" +
  "*Red*:\n1. Mojib\n2. Burak Yildiz\n3. Habib\n4. Kieran\n5. Raihan\n\n" +
  "*Yellow*:\n1. Kemal\n2. Mustafa Cayir\n3. Wasim\n4. Idris Yildiz\n5. Abid Kazmi";

type Ctx = { author: string | null; body: string };

/**
 * `echo` is the reconstructed incident window, in order, exactly as the
 * Pi's buffer held it when Mojib's "In" was extracted — the four
 * affirmatives that preceded his, each recorded before its own flush.
 * `quiet` is the same group with ordinary chat in front instead.
 */
const CONTEXTS: Record<string, Ctx[]> = {
  echo: [
    { author: "Nunu", body: "in" },
    { author: "Wasimp", body: "In" },
    { author: "Abid Kazmi", body: "In" },
  ],
  quiet: [
    { author: "Kemal Ediz", body: "Tuesday 15th, Goals North Cheam, 20:30. Who's about?" },
    { author: "Idris", body: "What a story, Como is turning to be 👏" },
  ],
};

interface Outcome {
  claimless: boolean;
  affirmation: string | null;
  selfIn: boolean;
  costUsd: number;
  failed: boolean;
}

async function once(
  model: ReturnType<typeof anthropicModel>,
  body: string,
  history: Ctx[],
  id: string,
): Promise<Outcome> {
  const res = await extractForRoute(model, "self_att", {
    id,
    body,
    authorName: "Mojib Jalali",
    tagged: false,
    // The message itself is the last thing in the buffer: `index.ts`
    // calls `recordHistory` before `enqueueForAnalysis`, so the Pi
    // forwards a window that already contains the message being
    // extracted. Reproducing that matters — it is the difference
    // between four identical "In"s in front of this one and three.
    history: [...history, { author: "Mojib Jalali", body }],
    lastBotPost: LAST_BOT_POST,
  });
  if (res.facts.kind !== "attendance") {
    return { claimless: true, affirmation: null, selfIn: false, costUsd: res.usage?.costUsd ?? 0, failed: true };
  }
  const f = res.facts as AttendanceFacts;
  const c = f.claims[0];
  return {
    claimless: f.claims.length === 0,
    affirmation: f.affirmation,
    selfIn: f.claims.length === 1 && c.subject === "sender" && c.polarity === "in",
    costUsd: res.usage?.costUsd ?? 0,
    failed: false,
  };
}

/** Run `tasks` with at most `limit` in flight. */
async function pool<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const out: T[] = new Array(tasks.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= tasks.length) return;
        out[i] = await tasks[i]();
      }
    }),
  );
  return out;
}

/**
 * ROUTES=1 — THE OTHER HALF OF THE ACCEPTANCE TEST.
 *
 * The engine's fallback for a claimless affirmation keys on the ROUTE:
 * `self_att` means "the SENDER is joining or leaving THIS match
 * themselves", so an affirmation on that route is the sender's own IN.
 * That makes the router the thing standing between a bare "yes" and a
 * registration nobody asked for, and a claim about the router is worth
 * nothing unmeasured.
 *
 * So: run the REAL router over the bare affirmatives, N times each, and
 * print the route distribution. `self_att` on a bare "yes" is the one
 * result that would make the fallback unsafe.
 */
async function measureRoutes(runs: number, concurrency: number) {
  const model = anthropicModel();
  let totalUsd = 0;
  console.log(
    `\n${"═".repeat(78)}\nROUTER DISTRIBUTION — is a bare affirmative ever \`self_att\`?\n${"═".repeat(78)}`,
  );
  for (const group of [
    { label: "BARE — must NOT be self_att", list: BARE },
    { label: "SELF-EVIDENT — self_att is correct and expected", list: SELF_EVIDENT },
  ]) {
    console.log(`\n  ── ${group.label} ──`);
    for (const body of group.list) {
      const results = await pool(
        Array.from({ length: runs }, (_, n) => async () => {
          const r = await routeBatch(model, [{ id: `m-${n}`, authorName: "Mojib Jalali", body }]);
          totalUsd += r.usage?.costUsd ?? 0;
          return r.routes[0]?.route ?? "?";
        }),
        concurrency,
      );
      const spread = [...new Set(results)]
        .map((rt) => ({ rt, n: results.filter((x) => x === rt).length }))
        .sort((a, b) => b.n - a.n)
        .map(({ rt, n }) => `${rt} ${n}/${results.length}`)
        .join(" · ");
      const selfAtt = results.filter((r) => r === "self_att").length;
      console.log(
        `  ${JSON.stringify(body).padEnd(18)} ${spread}` +
          `${group.list === BARE && selfAtt > 0 ? `   ⚠️  ${selfAtt} would reach the fallback` : ""}`,
      );
    }
  }
  // ── THE SAME WORD, INSIDE THE BATCH IT BELONGS TO ─────────────────
  //
  // A bare affirmative alone in a batch and the same word answering
  // something are two different messages, and the router is the only
  // stage that can tell them apart because it is the only one that sees
  // the batch. The first case is real production traffic: Kemal asked
  // "@Wasim can Najib come please?" on 2026-09-08 and Wasim replied
  // "Yes" — routed `none`, handled by nobody, correctly.
  const BATCHES: Array<{ label: string; msgs: Array<{ who: string; body: string }> }> = [
    {
      label: "a 'Yes' answering a teammate's question (live, 2026-09-08)",
      msgs: [
        { who: "Kemal Ediz", body: "@Wasim can Najib come please?" },
        { who: "Wasimp", body: "Yes" },
      ],
    },
    {
      label: "a 'yes' answering an off-topic question",
      msgs: [
        { who: "Idris", body: "did anyone watch the Como game last night?" },
        { who: "Mojib Jalali", body: "yes" },
      ],
    },
    {
      label: "a 'sure' answering a favour asked of somebody",
      msgs: [
        { who: "Kemal Ediz", body: "@Wasim could you bring the bibs on Tuesday?" },
        { who: "Wasimp", body: "sure" },
      ],
    },
  ];
  console.log(`\n  ── IN A BATCH — the same word, with what it answers beside it ──`);
  for (const b of BATCHES) {
    const results = await pool(
      Array.from({ length: runs }, (_, n) => async () => {
        const r = await routeBatch(
          model,
          b.msgs.map((m, i) => ({ id: `${n}-${i}`, authorName: m.who, body: m.body })),
        );
        totalUsd += r.usage?.costUsd ?? 0;
        return r.routes[r.routes.length - 1]?.route ?? "?";
      }),
      concurrency,
    );
    const spread = [...new Set(results)]
      .map((rt) => ({ rt, n: results.filter((x) => x === rt).length }))
      .sort((a, b2) => b2.n - a.n)
      .map(({ rt, n }) => `${rt} ${n}/${results.length}`)
      .join(" · ");
    const selfAtt = results.filter((r) => r === "self_att").length;
    console.log(
      `  ${JSON.stringify(b.msgs[b.msgs.length - 1].body).padEnd(8)} ${b.label}\n` +
        `           -> ${spread}${selfAtt > 0 ? `   ⚠️  ${selfAtt} would reach the fallback` : ""}`,
    );
  }

  console.log(`\n${"═".repeat(78)}\nTotal cost: $${totalUsd.toFixed(4)}. Writes performed: 0.`);
}

async function main() {
  // The DEVELOPER's key, assigned over ANTHROPIC_API_KEY for this
  // process so `routeBatch` and `extractForRoute`, the same code
  // production runs, pick it up unchanged. Refuses rather than falling
  // back: this sweep is 16+ real calls and they belong on the
  // development bill (MDs/llm-spend-september-2026.md).
  spendDevApiKeyOrExit("scripts/measure-claimless.ts");
  const runs = Math.max(1, Number(process.env.RUNS ?? 20));
  if (process.env.ROUTES === "1") {
    await measureRoutes(runs, Math.max(1, Number(process.env.CONCURRENCY ?? 8)));
    return;
  }
  const concurrency = Math.max(1, Number(process.env.CONCURRENCY ?? 8));
  const which = process.env.CONTEXT ?? "echo";
  const contextNames = which === "all" ? Object.keys(CONTEXTS) : [which];
  for (const n of contextNames) {
    if (!(n in CONTEXTS)) {
      throw new Error(`CONTEXT="${n}" is not one of: ${Object.keys(CONTEXTS).join(", ")}, all`);
    }
  }
  const only = process.env.ONLY?.split(",").map((s) => s.trim());
  const selected = only ? PHRASINGS.filter((p) => only.includes(p)) : PHRASINGS;
  if (selected.length === 0) throw new Error("ONLY selected no phrasing");

  const model = anthropicModel();
  let totalUsd = 0;

  for (const ctxName of contextNames) {
    const history = CONTEXTS[ctxName];
    console.log(
      `\n${"═".repeat(78)}\nRECENT CHAT = ${ctxName}\n` +
        history.map((h) => `    ${h.author}: ${JSON.stringify(h.body)}`).join("\n") +
        `\n${"═".repeat(78)}`,
    );
    for (const group of [
      { label: "SELF-EVIDENT — a claim is the only correct read", list: SELF_EVIDENT },
      { label: "BARE — claimless is CORRECT here; these must stay silent", list: BARE },
    ]) {
      const list = group.list.filter((p) => selected.includes(p));
      if (list.length === 0) continue;
      console.log(`\n  ── ${group.label} ──`);
      for (const body of list) {
        const results = await pool(
          Array.from({ length: runs }, (_, n) => () => once(model, body, history, `m-${n}`)),
          concurrency,
        );
        for (const r of results) totalUsd += r.costUsd;
        const claimless = results.filter((r) => r.claimless).length;
        const failed = results.filter((r) => r.failed).length;
        const affYes = results.filter((r) => r.claimless && r.affirmation === "yes").length;
        const odd = results.filter((r) => !r.claimless && !r.selfIn).length;
        console.log(
          `  ${JSON.stringify(body).padEnd(18)} CLAIMLESS ${String(claimless).padStart(2)} of ${runs}` +
            `   (claimless with affirmation=yes: ${affYes})` +
            `${odd ? `   ⚠️ ${odd} read as something other than one sender IN` : ""}` +
            `${failed ? `   💥 ${failed} extractor failure(s)` : ""}`,
        );
      }
    }
  }

  console.log(`\n${"═".repeat(78)}\nTotal cost: $${totalUsd.toFixed(4)}. Writes performed: 0.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
