/**
 * AN ORGANISER CALLING THE GAME OFF WITHOUT A TAG: THE PAID CHECK
 * (2026-10-29, Vets MNF 26 Oct).
 *
 *   node --env-file=.env --import tsx scripts/live-check-untagged-calloff.ts [--router]
 *
 * Default: each case ONCE through the real call-off reader
 * (`calloff-reader.ts`, the exact production prompts), with the group's
 * recent chat, and each DM reply once through the reply reader.
 *
 * --router: what the SHIPPED router and admin extractor make of the same
 * call-offs (the measurement that decided a step of its own was needed:
 * "it's off gents" routed admin_ops in one batch and none in another).
 *
 * Spends ANTHROPIC_API_KEY_DEV only (refuses without it). No database,
 * sends nothing. Prints each case, the calls made and the cost. Stops at
 * MAX_USD.
 */
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { anthropicModel, type PipelineModel } from "../src/lib/pipeline/llm.ts";
import { routeBatch } from "../src/lib/pipeline/router.ts";
import { extractForRoute } from "../src/lib/pipeline/extractors.ts";
import { readGroupCalloff, readCalloffReply } from "../src/lib/calloff-reader.ts";
import { calloffCopy } from "../src/lib/i18n/calloff-offer.ts";
import type { ContextMessage } from "../src/lib/reply-context.ts";

const MAX_USD = 0.5;
spendDevApiKeyOrExit("the untagged call-off live check");

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

interface Line {
  author: string;
  body: string;
}
interface Case {
  history: Line[];
  author: string;
  body: string;
  reply?: ContextMessage;
  lang?: "en" | "tr";
  want: boolean;
  why: string;
}

const NOW = new Date("2026-10-26T18:28:00Z");
const GAME_EN = "Monday 26 October, 20:30 (Vets MNF)";
const GAME_TR = "26 Ekim Pazartesi 20:30 (Pazartesi Halı Saha)";

const VETS_BEFORE: Line[] = [
  { author: "Davide", body: "List for 26 October:\n1. Davide\n4. Steff (paid pensioners rate)\n6. Craig (PAYG)\n9. Steve\n10. Dean\n11. Smiler\n13. Jon\n14. Lucas" },
  { author: "Lucas", body: "Sorry lads can't make it today my missus just dislocated her knee so I can imagine ima be up a&e for the rest of my day" },
  { author: "Lucas", body: "If anything changes I'll let you know" },
  { author: "Steff", body: "Shite 😬😬" },
  { author: "Craig", body: "Sorry to hear that mate but looks like we might have to get the Romanians @Steff" },
];
const TR_BEFORE: Line[] = [
  { author: "Emre", body: "Bu akşam kaç kişiyiz?" },
  { author: "Ali", body: "7 kişi var sadece" },
  { author: "Can", body: "ben de gelemiyorum maalesef" },
];

const GROUP: Case[] = [
  { history: VETS_BEFORE, author: "Steff", body: "Alright, so it's off gents, enjoy your evenings at home", want: true, why: "Vets MNF 26 Oct, the incident" },
  { history: TR_BEFORE, author: "Ali", body: "Tamam beyler, sayı tutmadı, bu akşam maç yok. İyi akşamlar", lang: "tr", want: true, why: "TR call-off" },
  {
    history: [{ author: "Mark", body: "Are we off for tonight?" }],
    author: "Steff",
    body: "Yes",
    reply: { at: null, text: "Are we off for tonight?", topic: null, match: null, author: { name: "Mark" } },
    want: true,
    why: "a yes to 'are we off?'",
  },
  { history: VETS_BEFORE, author: "Mark", body: "Are we off for tonight?", want: false, why: "a question" },
  { history: TR_BEFORE, author: "Ali", body: "bu akşam maç var mı yok mu?", lang: "tr", want: false, why: "TR question" },
  { history: [{ author: "Craig", body: "this rain is biblical" }], author: "Steff", body: "if it keeps going like this it'll be off lol, bring your snorkels", want: false, why: "banter about a maybe" },
  { history: VETS_BEFORE, author: "Craig", body: "Sorry to hear that mate but looks like we might have to get the Romanians @Steff", want: false, why: "a maybe, looking for players" },
  { history: [], author: "Davide", body: "Defo won't play in December", want: false, why: "another period" },
  { history: [], author: "Steff", body: "Can't make it tonight lads, sorry, work", want: false, why: "the organiser's own OUT" },
  { history: VETS_BEFORE, author: "Steff", body: "@Davide we gonna try to play November or reconvene in February?", want: false, why: "about next month" },
];

const REPLIES: Array<{ text: string; lang: "en" | "tr"; want: "yes" | "no" | "other" }> = [
  { text: "cancel", lang: "en", want: "yes" },
  { text: "yeah go on, it's off", lang: "en", want: "yes" },
  { text: "evet iptal et", lang: "tr", want: "yes" },
  { text: "iptal", lang: "tr", want: "yes" },
  { text: "no it's still on, we found two more", lang: "en", want: "no" },
  { text: "what time is kickoff?", lang: "en", want: "other" },
];

async function routerCheck() {
  for (const c of GROUP.filter((g) => g.want)) {
    const r = await routeBatch(model, [{ id: "m1", authorName: c.author, body: c.body }], { floor: true });
    const route = r.routes[0]?.route ?? null;
    let detail = "";
    if (route === "admin_ops") {
      const ex = await extractForRoute(model, "admin_ops", { id: "m1", body: c.body, authorName: c.author, tagged: false, history: c.history, lastBotPost: null });
      detail = ` -> ${ex.facts.kind === "admin" ? ex.facts.action : ex.facts.kind}`;
    }
    console.log(`router: ${JSON.stringify(c.body)} routed ${route}${detail}  (${c.why})`);
  }
}

async function main() {
  if (process.argv.includes("--router")) {
    await routerCheck();
    console.log(`\nModel calls: ${calls}. Cost: $${usd.toFixed(4)} (dev key).`);
    return;
  }
  let pass = 0;
  let fail = 0;
  for (const c of GROUP) {
    const got = await readGroupCalloff(
      { authorName: c.author, body: c.body, game: c.lang === "tr" ? GAME_TR : GAME_EN, history: c.history, reply: c.reply ?? null, now: NOW },
      { model },
    );
    const ok = got === c.want;
    ok ? pass++ : fail++;
    console.log(`${ok ? "PASS" : "FAIL"}  group ${JSON.stringify(c.body)} calloff=${got}  (${c.why}; want ${c.want})`);
  }
  for (const r of REPLIES) {
    const got = await readCalloffReply({ question: calloffCopy(r.lang).offer({ day: r.lang === "tr" ? "Pazartesi" : "Monday" }), text: r.text, lang: r.lang }, { model });
    const ok = got === r.want;
    ok ? pass++ : fail++;
    console.log(`${ok ? "PASS" : "FAIL"}  reply ${JSON.stringify(r.text)} -> ${got}  (want ${r.want})`);
  }
  console.log(`\n${pass} passed, ${fail} failed. Model calls: ${calls}. Cost: $${usd.toFixed(4)} (dev key).`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  console.log(`Model calls: ${calls}. Cost: $${usd.toFixed(4)} (dev key).`);
  process.exit(1);
});
