/**
 * LIVE dry run for the fee-confirmation classifier.
 *
 * A stubbed test proves the WIRING. It cannot prove that the real model
 * refuses "great game 👍" — and that refusal is the entire point of the
 * change, so it has to be measured against the real model, repeatedly,
 * before shipping and again whenever the prompt or the model changes.
 *
 *   npx tsx --env-file=.env scripts/dryrun-fee-confirm.ts [repeats]
 *   LANG_UNDER_TEST=tr npx tsx --env-file=.env scripts/dryrun-fee-confirm.ts [repeats]
 *
 * `LANG_UNDER_TEST=tr` (Phase 3) runs the Turkish org's path: the Turkish
 * allowlist and the Turkish prompt, against Turkish replies, with
 * "harika maç 👍" as the case that must never release anything.
 *
 * It sends nothing to anybody, touches no database and moves no money:
 * it calls `classifyFeeReply` directly and prints what came back.
 *
 * The cases below are split by who has to be right. The ANCHORED cases
 * never reach the model at all (the allowlist decides them offline) and
 * are printed to prove exactly that. The MODEL cases are the ones the
 * allowlist abstains on, and the `neither` ones are lifted verbatim from
 * the live group — they are real messages this collector has written.
 */
import { anchoredFeeReply, classifyFeeReply, type FeeReply } from "../src/lib/fee-confirm.ts";

interface Case {
  text: string;
  want: FeeReply;
}

/** Decided offline by the allowlist. The model must never see these. */
const ANCHORED: Case[] = [
  { text: "👍", want: "yes" },
  { text: "✅", want: "yes" },
  { text: "yes", want: "yes" },
  { text: "yes send them", want: "yes" },
  { text: "confirm", want: "yes" },
  { text: "ok", want: "yes" },
  { text: "yep 👍", want: "yes" },
  { text: "no", want: "no" },
  { text: "not yet", want: "no" },
  { text: "❌", want: "no" },
];

/** The allowlist abstains; the model decides. */
const MODEL: Case[] = [
  // ⚠️ the bug, and the reason this file exists
  { text: "great game 👍", want: "neither" },
  { text: "cheers lads, great game 👍", want: "neither" },
  { text: "ok so I'll sort it tomorrow", want: "neither" },
  // real messages from the live group (AnalyzedMessage, Sutton FC)
  { text: "yes, Elvin still collects it", want: "neither" },
  { text: "ok i will call goals and switch to 7aside again", want: "neither" },
  { text: "sure will do", want: "neither" },
  { text: "yes pls, can you share the name?", want: "neither" },
  { text: "✅ means that player has been accepted to the main squad", want: "neither" },
  { text: "no worries mate, great game", want: "neither" },
  { text: "did Wasim turn up in the end?", want: "neither" },
  { text: "how many are in for next week?", want: "neither" },
  // natural go-aheads the allowlist cannot cover — the WIDENING
  { text: "yeah go on then, fire them out", want: "yes" },
  { text: "sounds right, send em over", want: "yes" },
  { text: "that's the one, send the links", want: "yes" },
  // natural refusals
  { text: "hold off until I've counted the cash", want: "no" },
  { text: "not yet mate, a couple of them paid me cash", want: "no" },
];

/** Turkish org (Phase 3): decided offline by the Turkish allowlist. */
const ANCHORED_TR: Case[] = [
  { text: "evet", want: "yes" },
  { text: "Tamam", want: "yes" },
  { text: "✅", want: "yes" },
  { text: "evet gönder", want: "yes" },
  { text: "👍", want: "yes" },
  { text: "hayır", want: "no" },
  { text: "bekle", want: "no" },
  { text: "şimdi değil", want: "no" },
];

/** Turkish org: the allowlist abstains, the model decides. */
const MODEL_TR: Case[] = [
  // ⚠️ the same bug, in Turkish
  { text: "harika maç 👍", want: "neither" },
  { text: "eline sağlık beyler, harika maçtı 👍", want: "neither" },
  { text: "tamam yarın hallederim", want: "neither" },
  { text: "evet, parayı yine Elvin topluyor", want: "neither" },
  { text: "kaç kişi ödüyor?", want: "neither" },
  { text: "tamam ben sahayı arayıp 7'ye 7'ye geçeriz", want: "neither" },
  { text: "sorun yok kardeşim, güzel maçtı", want: "neither" },
  { text: "Wasim geldi mi sonunda?", want: "neither" },
  // natural go-aheads
  { text: "tamam, yolla gitsin", want: "yes" },
  { text: "doğru, linkleri gönderebilirsin", want: "yes" },
  { text: "evet evet at hepsine", want: "yes" },
  // natural refusals
  { text: "şimdilik bekle, parayı bir sayayım", want: "no" },
  { text: "gönderme daha, iki kişi nakit verdi", want: "no" },
];

const LANG = process.env.LANG_UNDER_TEST === "tr" ? "tr" : "en";
const CTX = LANG === "tr"
  ? { amount: 8, matchName: "Cuma Maçı", lang: "tr" as const }
  : { amount: 10.3, matchName: "Tuesday 5-a-side" };
const ANCHORED_RUN = LANG === "tr" ? ANCHORED_TR : ANCHORED;
const MODEL_RUN = LANG === "tr" ? MODEL_TR : MODEL;

async function main() {
  const repeats = Number(process.argv[2] ?? "3") || 3;
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("REFUSING: no ANTHROPIC_API_KEY — a run that cannot reach the model proves nothing.");
    process.exit(1);
  }
  if (process.env.MT_TEST_FEE_REPLY_STUB_FILE) {
    console.error("REFUSING: MT_TEST_FEE_REPLY_STUB_FILE is set — this would measure the stub.");
    process.exit(1);
  }

  console.log(`── language: ${LANG} ──`);
  console.log(`── ANCHORED (decided offline, model never called) ──`);
  let anchoredBad = 0;
  for (const c of ANCHORED_RUN) {
    const got = anchoredFeeReply(c.text, LANG);
    const pass = got === c.want;
    if (!pass) anchoredBad++;
    console.log(`  ${pass ? "✓" : "✗"} ${JSON.stringify(c.text).padEnd(22)} → ${got ?? "abstain"}  (want ${c.want})`);
  }

  console.log(`\n── MODEL, ×${repeats} ──`);
  let modelBad = 0;
  let calls = 0;
  for (const c of MODEL_RUN) {
    if (anchoredFeeReply(c.text, LANG) !== null) {
      console.log(`  ! ${JSON.stringify(c.text)} was decided by the allowlist — it should not have been`);
      modelBad++;
      continue;
    }
    const got: FeeReply[] = [];
    for (let i = 0; i < repeats; i++) {
      got.push(await classifyFeeReply(c.text, CTX));
      calls++;
    }
    const agreed = got.filter((g) => g === c.want).length;
    const pass = agreed === repeats;
    if (!pass) modelBad++;
    console.log(
      `  ${pass ? "✓" : "✗"} ${agreed}/${repeats}  want=${c.want.padEnd(7)} got=[${got.join(", ")}]  ${JSON.stringify(c.text)}`,
    );
  }

  console.log(
    `\nanchored: ${ANCHORED_RUN.length - anchoredBad}/${ANCHORED_RUN.length}   model: ${MODEL_RUN.length - modelBad}/${MODEL_RUN.length} cases fully agreed over ${calls} live calls`,
  );
  process.exit(anchoredBad + modelBad > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
