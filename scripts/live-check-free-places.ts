/**
 * FREE PLACES THROUGH THE SHARED PIPELINE: THE PAID CHECK (2026-10-16).
 *
 * Approved by Kemal for the HQ work: dev key only, run once. The unit
 * tests stub the model; this proves the real router and the real admin
 * extractor read an organiser's own words for a free place, and that what
 * this change touched (the organisers' header in the router's user turn,
 * `ORGANISERS_HEADER`, and the admin extractor's prompt) still does
 * everything it did. The router's system prompt is NOT changed (see the
 * comment on `ORGANISERS_HEADER` for the measurement why):
 *
 *   A. HQ, a free place in natural words, EN and TR, tagged and not: the
 *      router must say admin_ops and the admin extractor fee_waiver with
 *      the right names. None of these is a worked example in a prompt.
 *   B. HQ, things that must NOT become a free place: a squad change that
 *      says "free" (available), organisers' chat about money.
 *   C. The players' group, "free" meaning available: still attendance.
 *   D. The admin extractor's existing actions (bulk payment, reminder,
 *      recruit, stats blast, other), since its prompt was rewritten.
 *   E. Every production message that talks about being free or paying,
 *      in its real batch, from the local extract (`.e2e/replay/source.json`,
 *      not in git): any of them now routed admin_ops is listed.
 *
 * The players' group's router input is byte for byte unchanged, so its
 * regression sweeps have nothing new to measure; C and E are kept as a
 * cheap check of that. Every existing HQ behaviour is
 * `scripts/live-check-admin-group.ts`, run once beside this, because the
 * header it is shown under changed.
 *
 *   ANTHROPIC_API_KEY_DEV=... npx tsx scripts/live-check-free-places.ts
 *
 * Spends ANTHROPIC_API_KEY_DEV only (refuses without it). No database,
 * sends nothing. Prints each case, the calls made and the cost. Stops at
 * MAX_USD.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { config as loadEnv } from "dotenv";
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { anthropicModel, type PipelineModel } from "../src/lib/pipeline/llm.ts";
import { routeBatch } from "../src/lib/pipeline/router.ts";
import { extractForRoute } from "../src/lib/pipeline/extractors.ts";
import { organisersContext } from "../src/lib/admin-group-context.ts";
import { batchMessages } from "../e2e/replay/reconstruct.ts";
import type { ReplaySource } from "../e2e/replay/types.ts";
import type { AdminFacts, Route } from "../src/lib/pipeline/types.ts";

loadEnv();
const MAX_USD = 3;
spendDevApiKeyOrExit("the free places live check");

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

const lc = (xs: string[] | undefined) => (xs ?? []).map((x) => x.toLowerCase().replace(/^@/, "")).sort();

interface RouteCase {
  text: string;
  hq: boolean;
  want: Route[];
  /** For admin_ops in HQ: the people the extractor must name. */
  free?: string[];
  why: string;
}

const ROUTES: RouteCase[] = [
  // A. HQ, a free place.
  { text: "Bilal washed the bibs, he's free this week", hq: true, want: ["admin_ops"], free: ["bilal"], why: "the brief's words, untagged" },
  { text: "@Match Time Bilal washed the bibs, he's free this week", hq: true, want: ["admin_ops"], free: ["bilal"], why: "tagged" },
  { text: "Tom doesn't pay this week, he did the bibs", hq: true, want: ["admin_ops"], free: ["tom"], why: "doesn't pay" },
  { text: "mark Sam as free for tonight", hq: true, want: ["admin_ops"], free: ["sam"], why: "mark free" },
  { text: "Sam and Ali both play free on Friday", hq: true, want: ["admin_ops"], free: ["ali", "sam"], why: "two names" },
  { text: "@Match Time Bilal's on the house tonight", hq: true, want: ["admin_ops"], free: ["bilal"], why: "on the house" },
  { text: "Ali bu hafta ücretsiz, formaları o yıkadı", hq: true, want: ["admin_ops"], free: ["ali"], why: "TR, ücretsiz" },
  { text: "Ali bu hafta ödemesin", hq: true, want: ["admin_ops"], free: ["ali"], why: "TR, ödemesin" },
  { text: "@Match Time Can bu hafta bedava oynuyor", hq: true, want: ["admin_ops"], free: ["can"], why: "TR, bedava" },
  { text: "formaları Burak yıkadı, bu hafta para vermesin", hq: true, want: ["admin_ops"], free: ["burak"], why: "TR, para vermesin" },
  // B. HQ, not a free place.
  { text: "Bilal is free on Friday, put him in", hq: true, want: ["other_att"], why: "free = available, and a place: the place wins" },
  { text: "Dan's free tonight, add him to the list", hq: true, want: ["other_att"], why: "free = available, add" },
  { text: "Tom out", hq: true, want: ["other_att"], why: "squad change" },
  { text: "who's paying for the bibs this week?", hq: true, want: ["none", "question"], why: "organisers' chat about money" },
  { text: "is Bilal free this week?", hq: true, want: ["none", "question", "unsure"], why: "asking each other if he can play" },
  { text: "@Match Time remind me on Monday to book the pitch", hq: true, want: ["admin_ops"], why: "another instruction stays admin_ops" },
  // C. Players' group, free meaning available.
  { text: "I'm free Tuesday if you need me", hq: false, want: ["self_att", "offer"], why: "availability" },
  { text: "I'm free this week, count me in", hq: false, want: ["self_att"], why: "free and in" },
  { text: "Bu hafta boşum, varım", hq: false, want: ["self_att"], why: "TR availability" },
  { text: "@Match Time Ali is free this week, add him", hq: false, want: ["other_att"], why: "free = available, add" },
  { text: "@Match Time Tom's free tonight, put him down", hq: false, want: ["other_att"], why: "free = available, put down" },
  { text: "free kick was outrageous last night 😂", hq: false, want: ["none"], why: "football chat" },
];

interface AdminCase {
  text: string;
  check: (f: AdminFacts) => boolean;
  why: string;
}
const ADMIN: AdminCase[] = [
  { text: "@Match Time Amir paid for 4 players", check: (f) => f.action === "bulk_payment" && f.count === 4 && /amir/i.test(f.payerRef ?? ""), why: "bulk payment, count" },
  { text: "@Match Time Amir paid for Faris and Adam", check: (f) => f.action === "bulk_payment" && lc(f.coveredRefs).join(",") === "adam,faris", why: "bulk payment, names" },
  { text: "remind me on Tuesday morning at 9am instead please", check: (f) => f.action === "reminder" && /tuesday/i.test(f.phrase ?? ""), why: "reminder" },
  { text: "@Match Time remind me on Monday to bring the bibs", check: (f) => f.action === "reminder" && /monday/i.test(f.phrase ?? "") && /bibs/i.test(f.note ?? ""), why: "reminder with a note" },
  { text: "@Match Time message all players who played in the last 5 matches and invite them", check: (f) => f.action === "recruit" && f.lookbackMatches === 5, why: "recruit, lookback" },
  { text: "@Match Time we need more players, can you round some up", check: (f) => f.action === "recruit", why: "recruit" },
  { text: "@Match Time list the players", check: (f) => f.action === "other", why: "show is not recruit" },
  { text: "@Match Time send everyone their stats", check: (f) => f.action === "stats_blast", why: "stats blast" },
  { text: "@Match Time share the stats links with the lads", check: (f) => f.action === "stats_blast", why: "stats blast, natural" },
  { text: "lads don't forget to rate the players via the link MatchTime DM'ed you", check: (f) => f.action === "other", why: "instructs the players" },
  { text: "did everyone get their stats link?", check: (f) => f.action === "other", why: "a question" },
  { text: "@Match Time DM me the link for switching to 7aside", check: (f) => f.action === "other", why: "other" },
  { text: "@Match Time what are my stats", check: (f) => f.action === "other", why: "one person, themselves" },
];

const ORG_CONTEXT = organisersContext({ pending: [], quoted: null, quotedIsMatchTime: false, recent: [] });

async function main() {
  let pass = 0;
  let fail = 0;
  console.log(`\n== Routes (A, B, C): ${ROUTES.length} cases, each once ==\n`);
  for (const [i, c] of ROUTES.entries()) {
    const id = `r${i}`;
    const r = await routeBatch(
      model,
      [{ id, authorName: "Raihan", body: c.text, ...(c.hq ? { organisers: { context: ORG_CONTEXT } } : {}) }],
      { floor: true },
    );
    const route = r.routes[0]?.route;
    let ok = !!route && c.want.includes(route);
    let extra = "";
    if (ok && c.free && route === "admin_ops") {
      const ex = await extractForRoute(model, "admin_ops", { id, body: c.text, authorName: "Raihan", tagged: true, history: [], lastBotPost: null });
      const f = ex.facts.kind === "admin" ? ex.facts : null;
      ok = !!f && f.action === "fee_waiver" && lc(f.coveredRefs).join(",") === c.free.join(",");
      extra = ` -> ${JSON.stringify(f && { action: f.action, coveredRefs: f.coveredRefs })}`;
    }
    ok ? pass++ : fail++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${c.hq ? "HQ " : "PG "} ${JSON.stringify(c.text)}  routed ${route}${extra}   (${c.why}; want ${c.want.join("|")}${c.free ? ` free ${c.free.join(",")}` : ""})`);
  }

  console.log(`\n== Admin extractor (D): ${ADMIN.length} existing behaviours, each once ==\n`);
  for (const [i, c] of ADMIN.entries()) {
    const ex = await extractForRoute(model, "admin_ops", { id: `a${i}`, body: c.text, authorName: "Kemal", tagged: true, history: [], lastBotPost: null });
    const f = ex.facts.kind === "admin" ? ex.facts : null;
    const ok = !!f && c.check(f);
    ok ? pass++ : fail++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${JSON.stringify(c.text)}  ${JSON.stringify(f)}   (${c.why})`);
  }

  // E. Production messages about being free or paying, in their real batches.
  const SOURCE = path.join(process.cwd(), ".e2e", "replay", "source.json");
  if (existsSync(SOURCE)) {
    const source = JSON.parse(readFileSync(SOURCE, "utf8")) as ReplaySource;
    const WORDS = /\bfree\b|\bpaid\b|\bpay\b|ücretsiz|bedava|ödeme|öde/i;
    const batches = batchMessages(source.messages.filter((m) => (m.body ?? "").trim().length > 0)).filter((b) =>
      b.messages.some((m) => WORDS.test(m.body ?? "")),
    );
    let seen = 0;
    const flagged: string[] = [];
    for (const b of batches) {
      const res = await routeBatch(
        model,
        b.messages.map((m) => ({ id: m.waMessageId, authorName: m.authorName, body: m.body ?? "" })),
        { floor: true, awaiting: null },
      );
      const by = new Map(res.routes.map((r) => [r.messageId, r.route]));
      for (const m of b.messages) {
        if (!WORDS.test(m.body ?? "")) continue;
        seen++;
        if (by.get(m.waMessageId) === "admin_ops") flagged.push((m.body ?? "").replace(/\n/g, " ").slice(0, 110));
      }
    }
    console.log(`\n== Production (E): ${seen} messages about being free or paying, in ${batches.length} real batches ==`);
    console.log(`  routed admin_ops: ${flagged.length}`);
    for (const f of flagged) console.log(`    ${JSON.stringify(f)}`);
  } else {
    console.log(`\n== Production (E): skipped, no extract at ${SOURCE} ==`);
  }

  console.log(`\n${pass} passed, ${fail} failed. Model calls: ${calls}. Cost: $${usd.toFixed(4)} (dev key).`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  console.log(`Model calls: ${calls}. Cost: $${usd.toFixed(4)} (dev key).`);
  process.exit(1);
});
