/**
 * LIVE check (2026-10-29, review of #465): a player's DM reply to "Join
 * <Month> as a regular for the N games left?", read by the monthly reader
 * with that question as the message he replies to (`month-join-dm.ts`).
 * Each case ONCE. Spends ANTHROPIC_API_KEY_DEV only; no database.
 *
 *   node --env-file=.env ./node_modules/.bin/tsx scripts/dryrun-month-join-reply.ts
 */
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { anthropicModel, type PipelineModel } from "../src/lib/pipeline/llm.ts";
import { readMonthlyMessage, type MonthlyReading } from "../src/lib/monthly-reader.ts";
import type { MonthlyReaderContext } from "../src/lib/monthly-reader-prompt.ts";
import { t } from "../src/lib/i18n/t.ts";

const MAX_USD = 0.05;
const ctx: MonthlyReaderContext = {
  orgId: "org-dry",
  members: [
    { ref: "p1", userId: "u-davide", name: "Davide De Souza", aliases: [], organiser: true },
    { ref: "p2", userId: "u-oumesh", name: "Oumesh Sauba", aliases: [], organiser: false },
  ],
  months: ["  November 2026 (month 11): under way. 5 games: Mon 2 Nov (played), Mon 9 Nov (played), Mon 16 Nov, Mon 23 Nov, Mon 30 Nov; 3 still to play."],
  week: { game: "Mon 16 Nov 2026, 20:30", text: "📋 List for November: Mon 16 Nov, 20:30\n1. Davide De Souza" },
  seedable: false,
};
const ASK = (lang: "en" | "tr", of: number | null = null) =>
  t(lang).msu_dm_join_ask({ month: lang === "en" ? "November" : "Kasım", games: 3, of, price: of ? "£15.00" : "£22.50" });
const show = (r: MonthlyReading) => (r.kind === "signup" ? `signup:${r.choice}:${r.month}${r.games ? `:games${r.games}` : ""}` : r.kind);
// A question that carries his own 2 (2026-11-18): a plain yes is in; the
// code then joins him for the question's 2 unless the reading has another
// count (only a count other than 2 or 3 would be wrong).
const OF_OK = (g: string) => ["signup:in:11", "signup:in:11:games2", "signup:in:11:games3"].includes(g);
const CASES: Array<[string, "en" | "tr", (g: string) => boolean, string, number?]> = [
  ["yes", "en", (g) => g === "signup:in:11", "in"],
  ["evet", "tr", (g) => g === "signup:in:11", "in"],
  ["no thanks", "en", (g) => !g.startsWith("signup:in"), "not in"],
  ["hayır, gerek yok", "tr", (g) => !g.startsWith("signup:in"), "not in"],
  ["what time is kick off on Monday?", "en", (g) => g === "none", "none"],
  // 3 of the 3 left is every game left: 0 (since 2026-11-16) or 3, the same join.
  ["yes but only 3 games", "en", (g) => g === "signup:in:11:games3" || g === "signup:in:11", "in, every game left"],
  ["yes", "en", OF_OK, "in (his 2)", 2],
  ["evet", "tr", OF_OK, "in (his 2)", 2],
];

async function main() {
  const inner = anthropicModel({ apiKey: spendDevApiKeyOrExit("dryrun-month-join-reply") });
  let calls = 0;
  let usd = 0;
  const model: PipelineModel = {
    name: "metered",
    complete: async (req) => {
      if (usd >= MAX_USD) throw new Error("cost cap");
      const r = await inner.complete(req);
      calls++;
      usd += r.costUsd ?? 0.01;
      return r;
    },
  };
  let pass = 0;
  for (const [text, lang, ok, want, of] of CASES) {
    const r = await readMonthlyMessage(
      {
        body: text,
        sender: { userId: "u-oumesh", name: "Oumesh Sauba", organiser: false },
        history: [],
        reply: { at: new Date("2026-11-10T11:00:00Z"), text: ASK(lang, of ?? null), topic: null, match: null, author: null },
        now: new Date("2026-11-10T12:00:00Z"),
      },
      ctx,
      { model },
    );
    const g = show(r);
    const good = ok(g);
    if (good) pass++;
    console.log(`${good ? "PASS" : "FAIL"} [${lang}] ${JSON.stringify(text)} got ${g} (want ${want})`);
  }
  console.log(`\n${pass}/${CASES.length} as expected. ${calls} live calls, cost ≈ $${usd.toFixed(4)}`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
