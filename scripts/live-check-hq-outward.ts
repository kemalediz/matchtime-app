/**
 * WHAT LEAVES HQ NEEDS TO BE ASKED OF MATCHTIME: THE PAID CHECK
 * (2026-10-22).
 *
 * FNF HQ 07:22 UTC: "@89485761081551 can we ask Sutton group?" (the tag is
 * Kemal, a person) was routed ask_group and posted in the players' group.
 * Each case ONCE through the real router (the organisers' header, as
 * production renders it) and, on ask_group and admin_ops, the real admin
 * extractor, told truly whether the bot was tagged. What HQ would do, by
 * the same rule as `admin-group-understand.ts`:
 *
 *   out     ask_group, or admin_ops recruit from partner clubs, AND the
 *           message tags MatchTime or the extractor says toMatchTime
 *   quiet   anything else (nothing leaves HQ)
 *
 * Pre-approved for this change (paid tests on the dev key, cap $2).
 *
 *   npx tsx scripts/live-check-hq-outward.ts
 *
 * Spends ANTHROPIC_API_KEY_DEV only (refuses without it). No database,
 * sends nothing. Prints each case, the calls made and the cost.
 */
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { anthropicModel, type PipelineModel } from "../src/lib/pipeline/llm.ts";
import { routeBatch } from "../src/lib/pipeline/router.ts";
import { extractForRoute } from "../src/lib/pipeline/extractors.ts";
import { organisersContext } from "../src/lib/admin-group-context.ts";
// The tag as the Pi reports it for these cases: "@Match Time" written in the body
// (`messageMentionsBotExplicitly` was replaced by `piMentionsBot`, 2026-10-30).
const messageMentionsBotExplicitly = (m: { body: string }): boolean => /@match\s*time/i.test(m.body);

const MAX_USD = 0.75;
spendDevApiKeyOrExit("the HQ outward live check");

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

type Want = "out" | "quiet";
const CASES: Array<{ text: string; want: Want; why: string }> = [
  { text: "@89485761081551 can we ask Sutton group?", want: "quiet", why: "the incident, the tag unresolved" },
  { text: "@Kemal can we ask Sutton group?", want: "quiet", why: "the incident, the tag named" },
  { text: "@Match Time ask the group if anyone can play", want: "out", why: "tagged" },
  { text: "@Match Time gruba sor, oynayabilecek var mı", want: "out", why: "tagged, TR" },
  { text: "ask the group if anyone can play", want: "out", why: "untagged instruction" },
  { text: "MatchTime oyuncu grubuna sor", want: "out", why: "untagged instruction, TR" },
  { text: "should we ask the group?", want: "quiet", why: "asks the others" },
  { text: "gruba soralım mı?", want: "quiet", why: "asks the others, TR" },
  { text: "you able to find players?", want: "quiet", why: "asks a person" },
  { text: "@Raihan can you ask the group for one more?", want: "quiet", why: "asks a person by tag" },
  { text: "Hamzah sen Sutton'a sorar mısın?", want: "quiet", why: "asks a person, TR" },
  { text: "@Match Time ask Sutton if anyone can play", want: "out", why: "tagged, a partner club" },
];

async function main() {
  let pass = 0;
  let fail = 0;
  for (const [i, c] of CASES.entries()) {
    const id = `c${i}`;
    const tagged = messageMentionsBotExplicitly({ body: c.text });
    const context = organisersContext({ pending: [], recent: [] });
    const r = await routeBatch(model, [{ id, authorName: "Raihan", body: c.text, organisers: { context, senderIsOrganiser: true } }], { floor: true });
    const route = r.routes[0]?.route ?? null;
    let got: Want = "quiet";
    let detail = "";
    if (route === "ask_group" || route === "admin_ops") {
      const ex = await extractForRoute(model, "admin_ops", { id, body: c.text, authorName: "Raihan", tagged, history: [], lastBotPost: null });
      const f = ex.facts.kind === "admin" ? ex.facts : null;
      detail = ` -> ${f?.action ?? ex.facts.kind}${f?.partnerClubs ? ` partner "${f.clubRef ?? ""}"` : ""}, toMatchTime ${f?.toMatchTime === true}`;
      const asked = tagged || f?.toMatchTime === true;
      if (asked && (route === "ask_group" || (f?.action === "recruit" && f.partnerClubs))) got = "out";
    }
    const ok = got === c.want;
    ok ? pass++ : fail++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${JSON.stringify(c.text)}  routed ${route}${detail}   (${c.why}; want ${c.want})`);
  }
  console.log(`\n${pass} passed, ${fail} failed. Model calls: ${calls}. Cost: $${usd.toFixed(4)} (dev key).`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  console.log(`Model calls: ${calls}. Cost: $${usd.toFixed(4)} (dev key).`);
  process.exit(1);
});
