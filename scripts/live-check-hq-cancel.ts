/**
 * CANCELLING A MATCH FROM HQ, AND THE HELP NOISE: THE PAID CHECK
 * (2026-10-22).
 *
 * Each case ONCE through the real router (the organisers' header and
 * context as production renders them) and, on admin_ops, the real admin
 * extractor. What HQ would do:
 *
 *   cancel / restore   admin_ops, then the extractor's cancel_match /
 *                      restore_match (and the day it names)
 *   help               the help route: the menu
 *   not-cancel         anything that does not reach cancel_match or
 *                      restore_match (and is not help)
 *
 * Pre-approved for this change (paid tests on the dev key, cap $2).
 *
 *   ANTHROPIC_API_KEY_DEV=... npx tsx scripts/live-check-hq-cancel.ts
 *
 * Spends ANTHROPIC_API_KEY_DEV only (refuses without it). No database,
 * sends nothing. Prints each case, the calls made and the cost.
 */
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { anthropicModel, type PipelineModel } from "../src/lib/pipeline/llm.ts";
import { routeBatch } from "../src/lib/pipeline/router.ts";
import { extractForRoute } from "../src/lib/pipeline/extractors.ts";
import { organisersContext } from "../src/lib/admin-group-context.ts";

const MAX_USD = 0.5;
spendDevApiKeyOrExit("the HQ cancel live check");

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

type Want = "cancel" | "restore" | "help" | "not-cancel";
interface Case {
  text: string;
  want: Want;
  day?: string;
  recent?: Array<{ fromMatchTime: boolean; text: string }>;
  why: string;
}

const CASES: Case[] = [
  { text: "Cancel the session", want: "cancel", why: "FNF HQ 2026-10-22, untagged" },
  { text: "@Match Time cancel the session", want: "cancel", why: "tagged" },
  { text: "storm, no game Friday", want: "cancel", day: "friday", why: "a day named" },
  { text: "@Match Time maçı iptal et", want: "cancel", why: "TR" },
  { text: "bu hafta maç yok", want: "cancel", why: "TR, no game this week" },
  { text: "it's back on, uncancel Friday", want: "restore", day: "friday", why: "undo" },
  { text: "@Match Time maç yapılıyor, iptali geri al", want: "restore", why: "undo, TR" },
  {
    text: "let me get this enabled for you so when you tag @Match Time in the group and ask it to cancel, it will cancel the next match",
    want: "not-cancel",
    recent: [
      { fromMatchTime: false, text: "Cancel the session" },
      { fromMatchTime: true, text: "I can't do that from this group." },
    ],
    why: "FNF HQ 2026-10-22: talking to people about MatchTime, got the full help list",
  },
  { text: "LOOOL it's a bit sad but I guess with a storm on Friday night, the session should be cancelled anyways", want: "not-cancel", why: "an opinion to the others" },
  { text: "Please confirm if session is cancelled tomorrow", want: "not-cancel", why: "asking the other organisers" },
  { text: "@Match Time what can you do?", want: "help", why: "a real help ask" },
  { text: "neler yapabiliyorsun?", want: "help", why: "a real help ask, TR" },
];

async function main() {
  let pass = 0;
  let fail = 0;
  for (const [i, c] of CASES.entries()) {
    const id = `c${i}`;
    const context = organisersContext({ pending: [], recent: c.recent ?? [] });
    const r = await routeBatch(model, [{ id, authorName: "Hamzah", body: c.text, organisers: { context, senderIsOrganiser: true } }], { floor: true });
    const route = r.routes[0]?.route ?? null;
    let got: Want = route === "help" ? "help" : "not-cancel";
    let detail = "";
    if (route === "admin_ops") {
      const ex = await extractForRoute(model, "admin_ops", { id, body: c.text, authorName: "Hamzah", tagged: true, history: [], lastBotPost: null });
      const f = ex.facts.kind === "admin" ? ex.facts : null;
      detail = ` -> ${f?.action ?? ex.facts.kind}${f?.matchDay ? ` "${f.matchDay}"` : ""}`;
      if (f?.action === "cancel_match") got = "cancel";
      if (f?.action === "restore_match") got = "restore";
      if (c.day && got === c.want && !(f?.matchDay ?? "").toLowerCase().includes(c.day)) got = "not-cancel";
    }
    const ok = got === c.want;
    ok ? pass++ : fail++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${JSON.stringify(c.text)}  routed ${route}${detail}   (${c.why}; want ${c.want}${c.day ? ` on ${c.day}` : ""})`);
  }
  console.log(`\n${pass} passed, ${fail} failed. Model calls: ${calls}. Cost: $${usd.toFixed(4)} (dev key).`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  console.log(`Model calls: ${calls}. Cost: $${usd.toFixed(4)} (dev key).`);
  process.exit(1);
});
