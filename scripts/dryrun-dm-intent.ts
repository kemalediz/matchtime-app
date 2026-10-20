/**
 * LIVE dry run for the admin DM intent classifier (quoted-reply context
 * S3, 2026-10-20; none existed before).
 *
 * `src/lib/__tests__/dm-intent.test.ts` proves the wiring and the fail-
 * closed path with the model injected. Only the real model can show that
 * "DM the lads from the last few games" is a recruit blast while the 2026-
 * 09-10 reminder to the PLAYERS ("please do not forget to rate the
 * players...") and the 2026-09-01 "Najib is out. We need one more player."
 * are not, and, since S3, that "who's left?" answering MatchTime's rating
 * update is a rating-progress question while "done 👍" to the rating
 * request the admin got as a player is nothing. So this asks it, through
 * the production function.
 *
 *   REPEAT=1 node --env-file=.env ./node_modules/.bin/tsx scripts/dryrun-dm-intent.ts
 *   SET=heldout REPEAT=1 node --env-file=.env ./node_modules/.bin/tsx scripts/dryrun-dm-intent.ts
 *   SET=s3 REPEAT=1 node --env-file=.env ./node_modules/.bin/tsx scripts/dryrun-dm-intent.ts
 *
 * Spends ANTHROPIC_API_KEY_DEV only (refuses without it). Touches no
 * database and DMs nobody: it imports the classifier and prints what came
 * back, with the cost and a hard stop at MAX_USD.
 */
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { DM_INTENT_STUB_FILE_ENV, classifyDmIntent, type DmIntent } from "../src/lib/dm-intent.ts";
import { buildPayChaseDm, buildRatingDm } from "../src/lib/dm-copy.ts";
import { formatRatingProgressReply } from "../src/lib/rating-progress-answer.ts";
import { noReplyContext, pickRecentBotMessages, type ContextMessage, type ReplyContext } from "../src/lib/reply-context.ts";
import { HAIKU_CLASSIFIER_ARM, meter } from "./dm-dryrun-meter.ts";

const REPEAT = Number(process.env.REPEAT ?? "1") || 1;
const MAX_USD = 0.2;

interface Case {
  text: string;
  want: DmIntent;
  ctx?: ReplyContext;
  note?: string;
}

/** Wed 14 Oct 2026, 12:00 London: the day after a Tuesday match. */
const NOW = new Date("2026-10-14T11:00:00Z");
const MATCH = "Tuesday 7-a-side, Tue 13 Oct, 20:00";
const sent = (...msgs: ContextMessage[]): ReplyContext => ({ now: NOW, quoted: null, ...pickRecentBotMessages(msgs, NOW) });
const quoting = (m: ContextMessage): ReplyContext => ({ now: NOW, quoted: m, recent: [], earlier: null });

/** MatchTime's answer to an earlier "who hasn't rated?", from the real
 *  formatter: a queued BotJob (words, no key topic). */
const PROGRESS_REPLY: ContextMessage = {
  at: new Date("2026-10-14T10:30:00Z"),
  text: formatRatingProgressReply(
    {
      ok: true,
      matchName: "Tuesday 7-a-side",
      matchWhen: "Tue 13 Oct",
      confirmed: 12,
      ratedCount: 7,
      momCount: 6,
      notRated: ["Ali Khan", "Ben Bench", "Tom Third", "Sam Stale", "Ian Innes"],
      ratedNoMom: ["Riley Rater"],
    },
    "en",
  ),
  topic: null,
  match: null,
};
/** The rating request the admin got as a player, a scheduler DM. */
const RATING_DM: ContextMessage = {
  at: new Date("2026-10-13T21:30:00Z"),
  text: buildRatingDm({ activityName: "Tuesday 7-a-side", dateLabel: "Tue 13 Oct", mvpLabel: "Man of the Match", rateUrl: "https://mt.example/s/rate", statsUrl: "https://mt.example/s/stats", lang: "en" }),
  topic: "playerRating",
  match: MATCH,
};
const PAY_CHASE: ContextMessage = {
  at: new Date("2026-10-14T09:00:00Z"),
  text: buildPayChaseDm({ playerName: "Kemal", dayNum: 1, fee: 8, activityName: "Tuesday 7-a-side", url: "https://mt.example/s/pay", methods: ["card", "direct"], collectorName: "Elvin", lang: "en" }),
  topic: "paymentCollection",
  match: MATCH,
};

/** The two instructions, and the messages that must never fire one. */
const CASES: Case[] = [
  { text: "DM everyone who played in the last 5 matches and invite them", want: "recruit_blast" },
  { text: "we need a couple more for tuesday, can you message the recent lads", want: "recruit_blast" },
  { text: "we're short, round some players up", want: "recruit_blast" },
  { text: "son 5 maçta oynayan herkese yaz, davet et", want: "recruit_blast" },
  { text: "salıya iki kişi eksik, son gelenlere mesaj atar mısın", want: "recruit_blast" },
  { text: "who hasn't rated yet?", want: "rating_progress" },
  { text: "how many have picked a MoM so far", want: "rating_progress" },
  { text: "is everyone done rating", want: "rating_progress" },
  { text: "kim daha puan vermedi?", want: "rating_progress" },
  { text: "herkes puanladı mı", want: "rating_progress" },
  // the 2026-09-10 near-miss: it instructs the PLAYERS
  {
    text: "please do not forget to rate the players via the link from Matchtime DM'ed to you. the more accurate ratings, the more balanced teams next time",
    want: "other",
  },
  // the 2026-09-01 incident: it reports a drop
  { text: "Najib is out. We need one more player.", want: "other" },
  { text: "the lads keep asking me to DM them the ratings link", want: "other" },
  { text: "cheers for sorting the players out last week", want: "other" },
  { text: "I haven't rated yet, I'll do it tonight", want: "other" },
  { text: "who's playing tuesday?", want: "other" },
  { text: "can you remind everyone to rate the players", want: "other" },
  { text: "IN", want: "other" },
  { text: "sorry can't make tuesday", want: "other" },
  { text: "Ahmet yok. Bir kişi lazım.", want: "other" },
  { text: "salı kimler var?", want: "other" },
  { text: "herkese puan vermeyi hatırlat", want: "other" },
];

/** Phrasings that appear nowhere in the prompt. */
const HELD_OUT: Case[] = [
  { text: "can you ping last month's players and see who's free friday", want: "recruit_blast" },
  { text: "message the regulars who haven't signed up yet", want: "recruit_blast" },
  { text: "geçen ay gelenlere bir sor, cumaya kim gelir", want: "recruit_blast" },
  { text: "how many ratings are in?", want: "rating_progress" },
  { text: "who still owes a rating from last night", want: "rating_progress" },
  { text: "dünkü maç için kaç kişi puan verdi?", want: "rating_progress" },
  { text: "we're 2 short this week, shame", want: "other" },
  { text: "I told the lads to rate each other", want: "other" },
  { text: "great game last night", want: "other" },
  { text: "dün iyi maçtı", want: "other" },
];

/**
 * SLICE S3 (quoted-reply context): the message is read against what
 * MatchTime said to them.
 */
const SLICE_S3: Case[] = [
  { text: "who's left?", want: "rating_progress", ctx: quoting(PROGRESS_REPLY), note: "swipe-reply to MatchTime's rating update" },
  { text: "and the MoM?", want: "rating_progress", ctx: sent(RATING_DM, PROGRESS_REPLY), note: "not a reply: the rating update is the newest" },
  { text: "kim kaldı?", want: "rating_progress", ctx: quoting(PROGRESS_REPLY), note: "swipe-reply to MatchTime's rating update" },
  { text: "done 👍", want: "other", ctx: quoting(RATING_DM), note: "swipe-reply to his own rating request" },
  { text: "done 👍", want: "other", ctx: sent(RATING_DM), note: "not a reply: his own rating request is the newest" },
  { text: "can you DM the lads from the last few games and invite them", want: "recruit_blast", ctx: quoting(PAY_CHASE), note: "swipe-reply to his own pay chase: the words are still an instruction" },
  { text: "who hasn't rated yet?", want: "rating_progress", ctx: sent(PAY_CHASE), note: "after his own pay chase" },
];

async function main() {
  spendDevApiKeyOrExit("scripts/dryrun-dm-intent.ts");
  if (process.env[DM_INTENT_STUB_FILE_ENV]) {
    console.error(`REFUSING: ${DM_INTENT_STUB_FILE_ENV} is set, this would measure the stub.`);
    process.exit(1);
  }
  const m = meter("scripts/dryrun-dm-intent.ts", HAIKU_CLASSIFIER_ARM, MAX_USD);
  const sets: Record<string, Case[]> = { main: CASES, heldout: HELD_OUT, s3: SLICE_S3 };
  const setName = process.env.SET && sets[process.env.SET] ? process.env.SET : "main";
  const only = process.env.ONLY;
  const set = only ? sets[setName].filter((c) => c.text === only) : sets[setName];
  console.log(`── dm-intent classifier, ${HAIKU_CLASSIFIER_ARM.model}, set ${setName} (${set.length} cases), REPEAT=${REPEAT}, cap $${MAX_USD} ──`);
  let bad = 0;
  for (const c of set) {
    const got: string[] = [];
    const reasons: string[] = [];
    for (let i = 0; i < REPEAT; i++) {
      const r = await classifyDmIntent(c.text, { clubName: "Sutton FC", senderName: "Kemal Ediz", replyContext: c.ctx ?? noReplyContext(NOW) }, m.call);
      got.push(`${r.intent}@${r.confidence.toFixed(2)}`);
      reasons.push(r.reasoning);
    }
    const agreed = got.filter((g) => g.startsWith(`${c.want}@`)).length;
    const pass = agreed === REPEAT;
    if (!pass) bad++;
    console.log(
      `  ${pass ? "✓" : "✗"} ${agreed}/${REPEAT}  want=${c.want.padEnd(15)} got=[${got.join(", ")}]  ${JSON.stringify(c.text)}${c.note ? ` (${c.note})` : ""}`,
    );
    if (!pass) for (const why of reasons) console.log(`      reasoning: ${JSON.stringify(why)}`);
  }
  console.log(`\n${set.length - bad}/${set.length} cases fully agreed. ${m.summary()}`);
  process.exit(bad > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
