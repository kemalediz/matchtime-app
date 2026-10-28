/**
 * CANCELLING A MATCH FROM THE PLAYERS' GROUP: THE PAID CHECK (2026-10-23).
 *
 * Each case ONCE through the real router (a players' group message: no
 * organisers' header) and, on admin_ops, the real admin extractor. What the
 * players' group would do (`admin-ops-engine-batch.ts`):
 *
 *   cancel / restore   admin_ops, then cancel_match / restore_match (and
 *                      the day it names)
 *   not-cancel         anything else. A player cancelling HIS place is an
 *                      OUT, never the match.
 *
 * No prompt changed; this pins that the router and the extractor already
 * read these as the code now expects. Paid tests on the dev key, cap $2.
 *
 *   npx tsx scripts/live-check-players-cancel.ts
 *
 * Spends ANTHROPIC_API_KEY_DEV only (refuses without it). No database,
 * sends nothing. Prints each case, the calls made and the cost.
 */
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { anthropicModel, type PipelineModel } from "../src/lib/pipeline/llm.ts";
import { routeBatch } from "../src/lib/pipeline/router.ts";
import { extractForRoute } from "../src/lib/pipeline/extractors.ts";
import { messageMentionsBotExplicitly } from "../src/lib/interaction-contract.ts";

const MAX_USD = 0.5;
spendDevApiKeyOrExit("the players' group cancel live check");

let calls = 0;
let usd = 0;
const inner = anthropicModel();
const model: PipelineModel = {
  name: "metered",
  async complete(req) {
    if (usd >= MAX_USD) throw new Error(`stopped at $${MAX_USD}`);
    const r = await inner.complete(req);
    calls++;
    usd += r.costUsd ?? 0;
    return r;
  },
};

type Want = "cancel" | "restore" | "not-cancel";
interface Case {
  text: string;
  want: Want;
  day?: string;
  past?: boolean;
  why: string;
}

const CASES: Case[] = [
  { text: "@Match Time cancel the match", want: "cancel", why: "Friday MT Community 2026-10-23, the incident" },
  { text: "@Match Time cancel Friday's game, pitch is flooded", want: "cancel", day: "friday", why: "a day named" },
  { text: "@Match Time maçı iptal et", want: "cancel", why: "TR" },
  { text: "@Match Time the match is back on, uncancel it", want: "restore", why: "undo" },
  { text: "@Match Time maç yapılıyor, iptali geri al", want: "restore", why: "undo, TR" },
  { text: "@Match Time I can't make it, cancel me", want: "not-cancel", why: "a player's own OUT" },
  { text: "@Match Time is the match cancelled?", want: "not-cancel", why: "a question" },
  { text: "if it rains like this they'll cancel the match lol", want: "not-cancel", why: "banter" },
  // A game that did not happen (2026-10-28, Kemal: Sutton FC's Tuesday).
  { text: "@Match Time cancel last Tuesday's match", want: "cancel", day: "tuesday", past: true, why: "a past game, named" },
  { text: "@Match Time Tuesday's game didn't happen", want: "cancel", day: "tuesday", past: true, why: "a past game, it didn't happen" },
  { text: "@Match Time salı maçı olmadı, iptal et", want: "cancel", day: "salı", past: true, why: "a past game, TR" },
  { text: "@Match Time we never played last night, cancel it", want: "cancel", past: true, why: "last night" },
  { text: "Tuesday's game didn't happen lol, the pitch was locked", want: "not-cancel", why: "untagged chat about it" },
];

async function main() {
  let pass = 0;
  let fail = 0;
  for (const [i, c] of CASES.entries()) {
    const id = `c${i}`;
    const r = await routeBatch(model, [{ id, authorName: "Kemal", body: c.text }], { floor: true });
    const route = r.routes[0]?.route ?? null;
    let got: Want = "not-cancel";
    let detail = "";
    if (route === "admin_ops") {
      const ex = await extractForRoute(model, "admin_ops", { id, body: c.text, authorName: "Kemal", tagged: messageMentionsBotExplicitly({ body: c.text }), history: [], lastBotPost: null });
      const f = ex.facts.kind === "admin" ? ex.facts : null;
      detail = ` -> ${f?.action ?? ex.facts.kind}${f?.matchDay ? ` "${f.matchDay}"` : ""}${f?.pastGame ? " past" : ""}`;
      if (f?.action === "cancel_match") got = "cancel";
      if (f?.action === "restore_match") got = "restore";
      if (c.day && got === c.want && !(f?.matchDay ?? "").toLowerCase().includes(c.day)) got = "not-cancel";
      if ((got === "cancel" || got === "restore") && (f?.pastGame === true) !== (c.past === true)) got = "not-cancel";
    }
    const ok = got === c.want;
    ok ? pass++ : fail++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${JSON.stringify(c.text)}  routed ${route}${detail}   (${c.why}; want ${c.want}${c.day ? ` on ${c.day}` : ""}${c.past ? " past" : ""})`);
  }
  console.log(`\n${pass} passed, ${fail} failed. Model calls: ${calls}. Cost: $${usd.toFixed(4)} (dev key).`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  console.log(`Model calls: ${calls}. Cost: $${usd.toFixed(4)} (dev key).`);
  process.exit(1);
});
