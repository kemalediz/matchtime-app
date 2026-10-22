/**
 * LIVE dry run for the nameless volunteer's name reply (2026-10-22).
 *
 * The unit tests stub the model: they prove a "name" saves the name and
 * puts him in, an "out" saves nothing, an "other" asks again. Only the real
 * model can prove "it's Mark Smith" is a name, "actually can't make it" a
 * withdrawal and "which match?" neither. This asks it, ONCE per case.
 *
 *   node --env-file=.env ./node_modules/.bin/tsx scripts/dryrun-volunteer-name-reply.ts
 *
 * Spends ANTHROPIC_API_KEY_DEV only (refuses without it), through the exact
 * production call (`anthropicModel`, `VOLUNTEER_NAME_REPLY_CALL`, the
 * production prompt and parse). Touches no database and sends nothing.
 * Hard stop at MAX_USD.
 */
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { anthropicModel, type PipelineModel } from "../src/lib/pipeline/llm.ts";
import { readVolunteerNameReply, type VolunteerNameReply } from "../src/lib/volunteer-name-reply.ts";
import { t } from "../src/lib/i18n/t.ts";

const MAX_USD = 0.5;

const ctx = (lang: "en" | "tr") => {
  const day = lang === "en" ? "Fri 30 Oct, 20:30" : "30 Eki Cum, 20:30";
  return { askerName: "FNF", day, question: t(lang).xask_dm_name_ask({ asker: "FNF", day }) };
};

type Want = { kind: "name"; name: string } | { kind: "out" } | { kind: "other" };
const CASES: Array<{ text: string; lang: "en" | "tr"; want: Want }> = [
  // ── a name, alone or in a sentence ──
  { text: "Ali", lang: "en", want: { kind: "name", name: "Ali" } },
  { text: "it's Mark Smith", lang: "en", want: { kind: "name", name: "Mark Smith" } },
  { text: "Ben here", lang: "en", want: { kind: "name", name: "Ben" } },
  { text: "Mark, still in", lang: "en", want: { kind: "name", name: "Mark" } },
  { text: "  Omar  Second ", lang: "en", want: { kind: "name", name: "Omar Second" } },
  { text: "Adım Can", lang: "tr", want: { kind: "name", name: "Can" } },
  { text: "Cem Yılmaz, varım", lang: "tr", want: { kind: "name", name: "Cem Yılmaz" } },
  { text: "İlker", lang: "tr", want: { kind: "name", name: "İlker" } },
  // ── a withdrawal ──
  { text: "OUT", lang: "en", want: { kind: "out" } },
  { text: "actually can't make it", lang: "en", want: { kind: "out" } },
  { text: "sorry not anymore", lang: "en", want: { kind: "out" } },
  { text: "Ali but I can't come anymore", lang: "en", want: { kind: "out" } },
  { text: "yok gelemiyorum", lang: "tr", want: { kind: "out" } },
  { text: "vazgeçtim abi", lang: "tr", want: { kind: "out" } },
  // ── neither ──
  { text: "who is asking?", lang: "en", want: { kind: "other" } },
  { text: "which match?", lang: "en", want: { kind: "other" } },
  { text: "IN", lang: "en", want: { kind: "other" } },
  { text: "my mate Dave wants to come too", lang: "en", want: { kind: "other" } },
  { text: "hangi maç?", lang: "tr", want: { kind: "other" } },
  { text: "kimsin?", lang: "tr", want: { kind: "other" } },
];

async function main() {
  const inner = anthropicModel({ apiKey: spendDevApiKeyOrExit("dryrun-volunteer-name-reply") });
  let calls = 0;
  let usd = 0;
  let lastRaw = "";
  const model: PipelineModel = {
    name: "metered",
    complete: async (req) => {
      if (usd >= MAX_USD) throw new Error(`cost cap $${MAX_USD} reached after ${calls} calls`);
      const r = await inner.complete(req);
      calls++;
      usd += r.costUsd ?? 0.01;
      lastRaw = r.text;
      return r;
    },
  };
  const same = (got: VolunteerNameReply, want: Want) =>
    got.kind === want.kind && (got.kind !== "name" || want.kind !== "name" || got.name === want.name);
  let pass = 0;
  for (const c of CASES) {
    lastRaw = "";
    const got = await readVolunteerNameReply(c.text, ctx(c.lang), { model });
    const ok = same(got, c.want);
    if (ok) pass++;
    console.log(
      `${ok ? "PASS" : "FAIL"} [${c.lang}] ${JSON.stringify(c.text)} want=${c.want.kind}${c.want.kind === "name" ? `(${c.want.name})` : ""} ` +
        `got=${got.kind}${got.kind === "name" ? `(${got.name})` : got.kind === "other" ? `(${got.why})` : ""} raw=${lastRaw.replace(/\s+/g, " ").slice(0, 140)}`,
    );
  }
  console.log(`\n${pass}/${CASES.length} as expected. ${calls} live calls, cost ≈ $${usd.toFixed(4)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
