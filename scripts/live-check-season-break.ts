/**
 * A SEASON BREAK BY WHATSAPP: THE PAID CHECK (2026-10-29). Each case ONCE
 * through the real router and the real admin extractor, as production reads
 * it (players' group, the organisers' group, and a DM, which skips the
 * router). Spends ANTHROPIC_API_KEY_DEV only. No database, sends nothing.
 *
 *   node --env-file=.env ./node_modules/.bin/tsx scripts/live-check-season-break.ts [--first]
 */
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { anthropicModel, type PipelineModel } from "../src/lib/pipeline/llm.ts";
import { routeBatch } from "../src/lib/pipeline/router.ts";
import { extractForRoute } from "../src/lib/pipeline/extractors.ts";
import { organisersContext } from "../src/lib/admin-group-context.ts";

const MAX_USD = 0.2;
spendDevApiKeyOrExit("the season break live check");
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
const NOW = new Date("2026-10-29T12:00:00Z");
type Where = "PG" | "HQ" | "DM";
interface Case { text: string; where: Where; want: string }
const CASES: Case[] = [
  { text: "@Match Time no football in December", where: "PG", want: "break:2026-12|play:" },
  { text: "@Match Time aralıkta maç yok", where: "PG", want: "break:2026-12|play:" },
  { text: "@Match Time no football in December", where: "HQ", want: "break:2026-12|play:" },
  { text: "@Match Time aralık ve ocakta maç yok, şubatta dönüyoruz", where: "HQ", want: "break:2026-12,2027-01|play:2027-02" },
  { text: "no football in December", where: "DM", want: "break:2026-12|play:" },
  { text: "we're back mid January", where: "DM", want: "break:|play:2027-01" },
  { text: "ocak ortasında dönüyoruz", where: "DM", want: "break:|play:2027-01" },
  { text: "@Match Time storm, no game Friday", where: "PG", want: "cancel_match" },
  { text: "are we playing in December?", where: "DM", want: "not-break" },
  { text: "paid for November", where: "DM", want: "not-break" },
];

async function main() {
  const list = process.argv.includes("--first") ? CASES.slice(0, 1) : CASES;
  let pass = 0;
  for (const [i, c] of list.entries()) {
    const id = `c${i}`;
    let route: string | null = "admin_ops";
    if (c.where !== "DM") {
      const r = await routeBatch(
        model,
        [{ id, authorName: "Davide", body: c.text, ...(c.where === "HQ" ? { organisers: { context: organisersContext({ pending: [], recent: [] }), senderIsOrganiser: true } } : {}) }],
        { floor: true },
      );
      route = r.routes[0]?.route ?? null;
    }
    const ex = await extractForRoute(model, "admin_ops", { id, body: c.text, authorName: "Davide", tagged: true, history: [], lastBotPost: null, now: NOW });
    const f = ex.facts.kind === "admin" ? ex.facts : null;
    const got = f?.action === "season_break" ? `break:${(f.breakMonths ?? []).join(",")}|play:${(f.playMonths ?? []).join(",")}` : (f?.action ?? "none");
    const ok = c.want === "not-break" ? !got.startsWith("break:") : got === c.want && (c.want === "cancel_match" || route === "admin_ops");
    if (ok) pass++;
    console.log(`${ok ? "PASS" : "FAIL"} ${c.where} ${JSON.stringify(c.text)} routed ${route} extractor ${got} (want ${c.want})`);
  }
  console.log(`\n${pass}/${list.length} as expected. ${calls} live calls, cost ≈ $${usd.toFixed(4)}`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
