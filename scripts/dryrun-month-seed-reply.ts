/**
 * LIVE dry run for the organiser's DM answer to the coming month's draft
 * (2026-10-29, `src/lib/month-seed-reply.ts`). Each case ONCE through the
 * exact production call. Spends ANTHROPIC_API_KEY_DEV only; no database.
 *
 *   node --env-file=.env ./node_modules/.bin/tsx scripts/dryrun-month-seed-reply.ts
 */
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { anthropicModel, type PipelineModel } from "../src/lib/pipeline/llm.ts";
import { readSeedReply, type SeedReply } from "../src/lib/month-seed-reply.ts";
import { t } from "../src/lib/i18n/t.ts";

const MAX_USD = 0.2;
const MEMBERS = ["Davide De Souza", "Steff", "Craig", "Ben", "Steve", "Jon", "Sam Miles"].map((name, i) => ({
  ref: `p${i + 1}`,
  userId: `u${i + 1}`,
  name,
  aliases: name === "Sam Miles" ? ["smiler"] : [],
}));
const DRAFT = MEMBERS.slice(0, 6).map((m) => ({ ref: m.ref, name: m.name.split(" ")[0], kind: "regular" as const, games: null }));
const ASKED = (lang: "en" | "tr") =>
  t(lang).mwk_dm_seed_from_group({ month: lang === "en" ? "November" : "Kasım", count: 6, names: "Davide, Steff, Craig, Ben, Steve, Jon", unknown: null, link: "https://matchtime.app/admin/months", hq: false });
const CASES: Array<{ text: string; lang: "en" | "tr"; want: string }> = [
  { text: "yes", lang: "en", want: "yes" },
  { text: "looks good, go ahead 👍", lang: "en", want: "yes" },
  { text: "evet başlat", lang: "tr", want: "yes" },
  { text: "no, hold off till Friday", lang: "en", want: "no" },
  { text: "hayır bekle", lang: "tr", want: "no" },
  { text: "Craig is 4 only, Ben is PAYG", lang: "en", want: "change:games:u3:4,payg:u4" },
  { text: "add Smiler and take Jon off", lang: "en", want: "change:add:u7,remove:u6" },
  { text: "Craig sadece 4 hafta, Ben maç başı", lang: "tr", want: "change:games:u3:4,payg:u4" },
  { text: "who's on it?", lang: "en", want: "other" },
  { text: "paid my £37.50", lang: "en", want: "other" },
];
const show = (r: SeedReply) =>
  r.kind === "change" ? `change:${r.changes.map((c) => (c.action === "games" ? `games:${c.userId}:${c.games}` : `${c.action}:${c.userId}`)).sort().join(",")}` : r.kind;

async function main() {
  const inner = anthropicModel({ apiKey: spendDevApiKeyOrExit("dryrun-month-seed-reply") });
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
  const only = process.env.ONLY;
  for (const c of only ? CASES.filter((x) => x.text.includes(only)) : CASES) {
    const got = show(await readSeedReply({ draft: DRAFT, members: MEMBERS, asked: ASKED(c.lang), text: c.text }, { model }));
    const want = c.want.startsWith("change:") ? `change:${c.want.slice(7).split(",").sort().join(",")}` : c.want;
    const ok = got === want;
    if (ok) pass++;
    console.log(`${ok ? "PASS" : "FAIL"} [${c.lang}] ${JSON.stringify(c.text)} got ${got} (want ${want})`);
  }
  console.log(`\n${pass}/${CASES.length} as expected. ${calls} live calls, cost ≈ $${usd.toFixed(4)}`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
