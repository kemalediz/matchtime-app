/**
 * LIVE dry run for the roster check-in classifier (2026-10-19).
 *
 * The unit tests (`src/lib/__tests__/roster-survey-classifier.test.ts`)
 * prove the wiring with the model injected. Only the real model can show
 * that "Evet bu ay varım" and "yes I'm in this month" are read as `in`,
 * that a break with a way back stays `maybe`, and that "ok" stays
 * `unclear`, so this asks it, through the production function.
 *
 *   REPEAT=1 node --env-file=.env ./node_modules/.bin/tsx scripts/dryrun-roster-survey.ts
 *   SET=month REPEAT=1 node --env-file=.env ./node_modules/.bin/tsx scripts/dryrun-roster-survey.ts
 *   SET=s3 REPEAT=1 node --env-file=.env ./node_modules/.bin/tsx scripts/dryrun-roster-survey.ts
 *
 * `SET=month` runs only the time-bounded yes cases (the 2026-10-19 bug);
 * `SET=s3` the swipe-reply and recent-messages cases (quoted-reply context,
 * 2026-10-20); the default runs every other case, English and Turkish,
 * each read against the check-in as MatchTime's newest message to them.
 *
 * Spends ANTHROPIC_API_KEY_DEV only (refuses without it). Touches no
 * database and sends nothing: it imports the DB-free classifier and prints
 * what came back, with a running cost and a hard stop at MAX_USD.
 */
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import {
  classifyRosterReply,
  type RosterClassification,
  type RosterReplyContext,
} from "../src/lib/roster-survey-classifier.ts";
import { buildPayChaseDm, buildRatingDm, buildRosterSurveyInviteDm } from "../src/lib/dm-copy.ts";
import { pickRecentBotMessages, type ContextMessage, type ReplyContext } from "../src/lib/reply-context.ts";
import { HAIKU_CLASSIFIER_ARM, meter } from "./dm-dryrun-meter.ts";

const REPEAT = Number(process.env.REPEAT ?? "1") || 1;
/** Hard cap for this run, in US dollars. */
const MAX_USD = 0.2;

type Category = RosterClassification["category"];
interface Case {
  text: string;
  want: Category;
  lang: "en" | "tr";
  /** The chat context; absent: the check-in, as the newest message. */
  ctx?: ReplyContext;
  note?: string;
}

const en = (text: string, want: Category, ctx?: ReplyContext, note?: string): Case => ({ text, want, lang: "en", ctx, note });
const tr = (text: string, want: Category, ctx?: ReplyContext, note?: string): Case => ({ text, want, lang: "tr", ctx, note });

// ── The chat context, as `loadDmReplyContext` builds it ──
/** Mon 19 Oct 2026, 18:00 London. */
const NOW = new Date("2026-10-19T17:00:00Z");
/** The check-in went out Sunday evening. */
const CHECK_IN_AT = new Date("2026-10-18T17:00:00Z");
const sent = (...msgs: ContextMessage[]): ReplyContext => ({ now: NOW, quoted: null, ...pickRecentBotMessages(msgs, NOW) });
const quoting = (m: ContextMessage): ReplyContext => ({ now: NOW, quoted: m, recent: [], earlier: null });
/** The check-in itself, from the real composer: a queued BotJob (words, no topic). */
const checkIn = (lang: "en" | "tr"): ContextMessage => ({
  at: CHECK_IN_AT,
  text: buildRosterSurveyInviteDm({ firstName: "Ali", orgName: "Sutton FC", lang }),
  topic: null,
  match: null,
});
const MATCH = "Tuesday 7-a-side, Tue 13 Oct, 20:00";
const payChase = (lang: "en" | "tr"): ContextMessage => ({
  at: new Date("2026-10-19T16:00:00Z"),
  text: buildPayChaseDm({ playerName: "Ali", dayNum: 2, fee: 8, activityName: "Tuesday 7-a-side", url: "https://mt.example/s/pay", methods: ["card", "direct"], collectorName: "Kemal Ediz", lang }),
  topic: "paymentCollection",
  match: MATCH,
});
const ratingDm = (lang: "en" | "tr"): ContextMessage => ({
  at: new Date("2026-10-19T09:00:00Z"),
  text: buildRatingDm({ activityName: "Tuesday 7-a-side", dateLabel: lang === "tr" ? "13 Ekim Salı" : "Tue 13 Oct", mvpLabel: lang === "tr" ? "Maçın Adamı" : "Man of the Match", rateUrl: "https://mt.example/s/rate", statsUrl: "https://mt.example/s/stats", lang }),
  topic: "playerRating",
  match: MATCH,
});

/** A yes for a stated stretch (the 2026-10-19 bug). None of these is an
 *  example in the prompt, so a pass is the rule, not an echo. */
const MONTH: Case[] = [
  tr("Evet bu ay varım", "in"),
  en("yes I'm in this month", "in"),
  en("yes count me in for the month", "in"),
  tr("bu sezon varım", "in"),
  en("in until the summer at least", "in"),
];

const CASES: Case[] = [
  ...MONTH,
  // ── in ──
  en("yes", "in"),
  en("I'm in", "in"),
  en("definitely", "in"),
  en("still keen", "in"),
  en("of course", "in"),
  en("100%", "in"),
  en("always in mate", "in"),
  tr("evet", "in"),
  tr("varım", "in"),
  tr("devam", "in"),
  tr("tabii ki", "in"),
  tr("evet abi her hafta varım", "in"),
  // ── maybe: some weeks, it depends, or a break with a way back ──
  en("depends", "maybe"),
  en("sometimes", "maybe"),
  en("if I'm free", "maybe"),
  en("not every week", "maybe"),
  en("maybe", "maybe"),
  en("when I can", "maybe"),
  en("I'll play if there's room", "maybe"),
  en("not for now", "maybe"),
  en("not for now but maybe later", "maybe"),
  en("may come in the future", "maybe"),
  en("taking a break for a bit", "maybe"),
  en("we'll see how it goes", "maybe"),
  en("not this month, injured", "maybe"),
  en("hi, may be i will come in the near future but not for now", "maybe"),
  tr("belki", "maybe"),
  tr("ara sıra", "maybe"),
  tr("duruma göre", "maybe"),
  tr("şimdilik yok", "maybe"),
  tr("bir süre ara vereceğim", "maybe"),
  tr("sonra bakarız", "maybe"),
  tr("bu ay yokum, sakatım", "maybe"),
  // ── out: a clear stop, no way back ──
  en("I'm done", "out"),
  en("won't be playing anymore", "out"),
  en("I'm out for good", "out"),
  en("moving away", "out"),
  en("no thanks, please take me off", "out"),
  en("stopping football completely", "out"),
  tr("bırakıyorum", "out"),
  tr("artık oynamayacağım", "out"),
  tr("beni çıkarın", "out"),
  tr("taşındım, artık gelemem", "out"),
  // ── unclear: does not answer the check-in ──
  en("what is this?", "unclear"),
  en("who is this?", "unclear"),
  en("🙂", "unclear"),
  en("ok", "unclear"),
  en("thanks for letting me know", "unclear"),
  tr("tamam", "unclear"),
  tr("bu ne?", "unclear"),
  tr("kimsin sen?", "unclear"),
];

/**
 * SLICE S3 (quoted-reply context): which message the reply answers. A
 * bare "yes" swipe-replied to another message, or after a newer message
 * about something else, is not an answer to the check-in; words that
 * plainly answer it are, whatever came after.
 */
const SLICE_S3: Case[] = [
  en("yes", "in", quoting(checkIn("en")), "swipe-reply to the check-in, a pay chase came after"),
  en("yes", "unclear", quoting(payChase("en")), "swipe-reply to a pay chase"),
  en("yes", "unclear", sent(checkIn("en"), ratingDm("en")), "not a reply: the check-in, then a rating request"),
  en("still keen, count me in going forward", "in", sent(checkIn("en"), ratingDm("en")), "not a reply: the words answer the check-in"),
  en("I'm done with football, take me off", "out", sent(checkIn("en"), payChase("en")), "not a reply: the words answer the check-in"),
  tr("evet", "in", quoting(checkIn("tr")), "swipe-reply to the check-in"),
  tr("evet", "unclear", quoting(payChase("tr")), "swipe-reply to a pay chase"),
  tr("bu ay varım", "in", sent(checkIn("tr"), ratingDm("tr")), "not a reply: the words answer the check-in"),
];

async function main() {
  spendDevApiKeyOrExit("scripts/dryrun-roster-survey.ts");
  const m = meter("scripts/dryrun-roster-survey.ts", HAIKU_CLASSIFIER_ARM, MAX_USD);
  const MODEL = HAIKU_CLASSIFIER_ARM.model;
  const usd = () => m.usd();
  const call = m.call;

  const set = process.env.SET === "month" ? MONTH : process.env.SET === "s3" ? SLICE_S3 : CASES;
  console.log(`── roster check-in classifier, ${MODEL}, set ${process.env.SET ?? "all"} (${set.length} cases), REPEAT=${REPEAT}, cap $${MAX_USD} ──`);
  let bad = 0;
  for (const c of set) {
    const ctx: RosterReplyContext = {
      clubName: "Sutton FC",
      playerName: "Ali",
      checkInSentAt: CHECK_IN_AT,
      replyContext: c.ctx ?? sent(checkIn(c.lang)),
    };
    const got: string[] = [];
    const reasons: string[] = [];
    for (let i = 0; i < REPEAT; i++) {
      if (usd() >= MAX_USD) {
        console.error(`\nSTOPPED: cost cap $${MAX_USD} reached after ${m.calls()} calls.`);
        process.exit(2);
      }
      const r = await classifyRosterReply(c.text, ctx, call);
      got.push(`${r.category}@${r.confidence.toFixed(2)}`);
      reasons.push(r.reasoning);
    }
    const agreed = got.filter((g) => g.startsWith(`${c.want}@`)).length;
    const pass = agreed === REPEAT;
    if (!pass) bad++;
    console.log(`  ${pass ? "✓" : "✗"} ${agreed}/${REPEAT}  ${c.lang} want=${c.want.padEnd(7)} got=[${got.join(", ")}]  ${JSON.stringify(c.text)}${c.note ? ` (${c.note})` : ""}`);
    if (!pass) for (const why of reasons) console.log(`      reasoning: ${JSON.stringify(why)}`);
  }
  console.log(`\n${set.length - bad}/${set.length} cases fully agreed. ${m.summary()}`);
  process.exit(bad > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
