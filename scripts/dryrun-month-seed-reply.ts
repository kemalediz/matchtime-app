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
/** 2026-11-03: names on his list nobody matched, and members with no name,
 *  numbered as the DM shows them (`month-seed-match.ts`). */
const UNMATCHED = [
  { ref: "u1", name: "Craig" },
  { ref: "u2", name: "Oumesh" },
];
const NAMELESS = [
  { ref: "n1", n: 1, userId: "u-n1" },
  { ref: "n2", n: 2, userId: "u-n2" },
  { ref: "n3", n: 3, userId: "u-n3" },
];
const MATCH_MEMBERS = MEMBERS.filter((m) => m.name !== "Craig");
const MATCH_DRAFT = DRAFT.filter((d) => d.name !== "Craig");
const ASKED_MATCH = (lang: "en" | "tr") =>
  t(lang).mwk_dm_seed_from_group({
    month: lang === "en" ? "November" : "Kasım",
    count: 5,
    names: "Davide, Steff, Ben, Steve, Jon",
    unknown: null,
    match: {
      names: "Craig, Oumesh",
      members: ["1. +44 7700 900101", "2. +44 7700 900102", "3. +44 7700 900103"],
      example: t(lang).mwk_dm_seed_match_example({ name: "Craig", n: 1 }),
    },
    link: "https://matchtime.app/admin/months",
    hq: false,
  });
/** 2026-11-03: a RUNNING month. Davide put Zak (a new player now) and Luca
 *  (could be a member with no name, not added) on it, and was asked who
 *  they are (`month-newcomers.ts`): the same reader, no draft, the names as
 *  "not matched". Zak is a named member now (the new player). */
const NEWCOMER_MEMBERS = [...MEMBERS, { ref: "p8", userId: "u-zak-new", name: "Zak", aliases: [] }];
const NEWCOMER_UNMATCHED = [
  { ref: "u1", name: "Zak" },
  { ref: "u2", name: "Luca" },
];
const ASKED_NEWCOMERS = (lang: "en" | "tr") =>
  t(lang).mwk_dm_newcomers_ask({
    month: lang === "en" ? "November" : "Kasım",
    added: ["Zak"],
    waiting: ["Luca"],
    members: ["1. +44 7700 900101 (WhatsApp: Luca)", "2. +44 7700 900102", "3. +44 7700 900103"],
    example: t(lang).mwk_dm_seed_match_example({ name: "Zak", n: 1 }),
  });
const CASES: Array<{ text: string; lang: "en" | "tr"; want: string; match?: boolean; newcomers?: boolean }> = [
  // A running month's newcomers (2026-11-03): only "match" is acted on.
  { text: "Zak is 3", lang: "en", want: "change:match:u-n3:u1", newcomers: true },
  { text: "Zak is 2 and Luca is number 1", lang: "en", want: "change:match:u-n2:u1,match:u-n1:u2", newcomers: true },
  { text: "Zak 2 numara, Luca 1", lang: "tr", want: "change:match:u-n2:u1,match:u-n1:u2", newcomers: true },
  { text: "Luca is the first one", lang: "en", want: "change:match:u-n1:u2", newcomers: true },
  // Who is who (2026-11-03): the draft has two names nobody matched.
  { text: "Craig is 3, Oumesh is 1", lang: "en", want: "change:match:u-n3:u1,match:u-n1:u2", match: true },
  { text: "craig's the second one", lang: "en", want: "change:match:u-n2:u1", match: true },
  { text: "Craig 3 numara, Oumesh 1", lang: "tr", want: "change:match:u-n3:u1,match:u-n1:u2", match: true },
  { text: "yes go ahead", lang: "en", want: "yes", match: true },
  { text: "Craig is number 9", lang: "en", want: "other", match: true },
  { text: "Oumesh is 2 and Ben is PAYG", lang: "en", want: "change:match:u-n2:u2,payg:u4", match: true },
  // The cases from #465, unchanged.
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
  r.kind === "change"
    ? `change:${r.changes
        .map((c) => (c.action === "games" ? `games:${c.userId}:${c.games}` : c.action === "match" ? `match:${c.userId}:${c.listed}` : `${c.action}:${c.userId}`))
        .sort()
        .join(",")}`
    : r.kind;

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
    const got = show(
      await readSeedReply(
        c.newcomers
          ? { draft: [], members: NEWCOMER_MEMBERS, unmatched: NEWCOMER_UNMATCHED, nameless: NAMELESS, asked: ASKED_NEWCOMERS(c.lang), text: c.text }
          : c.match
            ? { draft: MATCH_DRAFT, members: MATCH_MEMBERS, unmatched: UNMATCHED, nameless: NAMELESS, asked: ASKED_MATCH(c.lang), text: c.text }
            : { draft: DRAFT, members: MEMBERS, asked: ASKED(c.lang), text: c.text },
        { model },
      ),
    );
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
