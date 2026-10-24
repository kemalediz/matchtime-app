/**
 * A POOL PLAYER'S REPLY TO HIS OFFER: THE PAID CHECK (slice L6, 2026-10-24).
 * Plan 5.3. The exact production prompt and user turn (`reply-reader.ts`)
 * on the real model (Haiku 5.5, the house thinking, structured output),
 * each case ONCE (the cheap plan). Dev key only.
 *
 *   ANTHROPIC_API_KEY_DEV=... npx tsx scripts/live-check-pool-reply.ts
 *
 * Each case is a reply, the offer it answers (EN or TR, as MatchTime sends
 * it), the offer's state, and whether he has a club of his own. It passes
 * when the reading would make MatchTime do the right thing:
 *   - accept / decline / stop / question: that intent at or above the floor;
 *   - neither: "neither", or anything below the floor (which only re-asks);
 *   - `alt`: other intents that are also right for an ambiguous reply.
 * A HARMFUL miss is a confident accept, decline or stop that was not wanted:
 * it would book, decline or stop without him meaning it. Counted apart.
 *
 * No database, sends nothing. Prints each case, the calls made and the
 * cost. Stops at MAX_USD.
 */
import { config as loadEnv } from "dotenv";
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { anthropicModel, type PipelineModel } from "../src/lib/pipeline/llm.ts";
import { londonDateTimeToUtc } from "../src/lib/london-time.ts";
import { poolOfferText, poolPlacedText, type PoolOfferFacts } from "../src/lib/pool/offer-copy.ts";
import { readPoolReply, type PoolReplyContext } from "../src/lib/pool/reply-reader.ts";
import { POOL_REPLY_MIN_CONFIDENCE, type OfferReplyState, type PoolReplyIntent } from "../src/lib/pool/reply-rules.ts";

loadEnv();
const MAX_USD = 1;
spendDevApiKeyOrExit("the pool offer reply live check");

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

const NOW = londonDateTimeToUtc("2026-10-27", "12:00");
const FACTS: PoolOfferFacts = {
  club: "FNF",
  places: 1,
  sport: "football",
  format: 7,
  kickoff: londonDateTimeToUtc("2026-10-30", "20:30"),
  durationMins: 60,
  venueName: "Goals North Cheam",
  address: "Cheam Common Rd, Worcester Park KT4 8RH",
  mapUrl: "https://www.google.com/maps/search/?api=1&query=51.37,-0.23",
  distanceMiles: 1.8,
  playStyle: "casual",
  members: 30,
  gamesLast8Weeks: 8,
  fee: { kind: "amount", amount: "£6" },
};
const LINKS = { tapLink: "https://matchtime.ai/play/offer/abc.SIGNED", manageLink: "https://matchtime.ai/r/x1" };
const offerText = (lang: "en" | "tr") => poolOfferText(lang, FACTS, LINKS);
const placedText = (lang: "en" | "tr") =>
  poolPlacedText(lang, { club: "FNF", kickoff: FACTS.kickoff, venueName: FACTS.venueName, bench: false, fee: FACTS.fee, offerLink: LINKS.tapLink, manageLink: LINKS.manageLink });

interface Case {
  text: string;
  want: PoolReplyIntent;
  alt?: PoolReplyIntent[];
  lang?: "en" | "tr";
  /** Default open (an offer he has not answered). */
  state?: OfferReplyState;
  /** His own club, when he has one. */
  club?: string;
  quoted?: boolean;
  why: string;
}

const CASES: Case[] = [
  // Accept, EN.
  { text: "yes", want: "accept", why: "plain yes" },
  { text: "Yes please!", want: "accept", why: "polite yes" },
  { text: "I'm in", want: "accept", why: "in" },
  { text: "count me in 👍", want: "accept", why: "emoji" },
  { text: "👍", want: "accept", alt: ["neither"], why: "a bare thumbs up" },
  { text: "yh go on then", want: "accept", why: "slang" },
  { text: "yesss pls", want: "accept", why: "typo" },
  { text: "sure, see you there", want: "accept", why: "see you there" },
  { text: "yes please, is there parking?", want: "accept", why: "a yes with a question" },
  { text: "yes but I might be 10 mins late", want: "accept", why: "a yes with a caveat" },
  // Accept, TR.
  { text: "evet", lang: "tr", want: "accept", why: "TR yes" },
  { text: "varım", lang: "tr", want: "accept", why: "TR I'm in" },
  { text: "olur gelirim", lang: "tr", want: "accept", why: "TR I'll come" },
  { text: "beni yaz abi", lang: "tr", want: "accept", why: "TR put me down" },
  { text: "evt varim", lang: "tr", want: "accept", why: "TR typo, no diacritics" },
  { text: "tamam geliyorum, otopark var mı?", lang: "tr", want: "accept", why: "TR yes with a question" },
  // Decline, EN.
  { text: "no thanks", want: "decline", why: "plain no" },
  { text: "can't make it sorry", want: "decline", why: "can't make it" },
  { text: "nah mate", want: "decline", why: "slang no" },
  { text: "cnt make it", want: "decline", why: "typo" },
  { text: "busy that night", want: "decline", why: "busy" },
  { text: "not this time, maybe next week", want: "decline", why: "not this time" },
  { text: "no, but where is it anyway?", want: "decline", why: "a no wins over a question" },
  // Decline, TR.
  { text: "hayır teşekkürler", lang: "tr", want: "decline", why: "TR no thanks" },
  { text: "gelemem", lang: "tr", want: "decline", why: "TR can't" },
  { text: "gelemiyom bu akşam", lang: "tr", want: "decline", why: "TR colloquial" },
  { text: "o akşam işim var", lang: "tr", want: "decline", why: "TR busy" },
  // Stop, EN and TR.
  { text: "stop sending me these", want: "stop", why: "stop" },
  { text: "take me off the list", want: "stop", why: "off the list" },
  { text: "no more game offers please", want: "stop", why: "no more offers" },
  { text: "unsubscribe", want: "stop", why: "unsubscribe" },
  { text: "no thanks, and please stop messaging me", want: "stop", why: "mixed: stop wins" },
  { text: "beni listeden çıkarın", lang: "tr", want: "stop", why: "TR off the list" },
  { text: "artık maç teklifi göndermeyin", lang: "tr", want: "stop", why: "TR no more offers" },
  // Question, EN and TR.
  { text: "where is it?", want: "question", why: "where" },
  { text: "is there parking?", want: "question", why: "parking" },
  { text: "how much is it?", want: "question", why: "fee" },
  { text: "what level are they?", want: "question", why: "level" },
  { text: "how long is the game", want: "question", why: "length, no question mark" },
  { text: "nerede?", lang: "tr", want: "question", why: "TR where" },
  { text: "ücret ne kadar?", lang: "tr", want: "question", why: "TR fee" },
  { text: "seviye nasıl?", lang: "tr", want: "question", why: "TR level" },
  // Neither: thanks, chat, banter, sarcasm, the unreadable.
  { text: "thanks", want: "neither", why: "thanks" },
  { text: "who is this?", want: "neither", alt: ["question"], why: "who is this" },
  { text: "haha nice one", want: "neither", why: "banter" },
  { text: "lol", want: "neither", why: "banter" },
  { text: "teşekkürler", lang: "tr", want: "neither", why: "TR thanks" },
  { text: "kimsin sen?", lang: "tr", want: "neither", alt: ["question"], why: "TR who is this" },
  { text: "oh brilliant, a stranger's game across town, just what I needed, sign me right up", want: "neither", alt: ["decline"], why: "sarcasm is not a yes" },
  { text: "maybe, depends on work", want: "neither", why: "undecided: never a confident answer" },
  { text: "belki, işe bağlı", lang: "tr", want: "neither", why: "TR undecided" },
  // A club member: his own club's business is not the offer.
  { text: "is our Tuesday game on?", club: "Sutton FC", want: "neither", why: "member, his own club" },
  { text: "what time is kickoff on thursday?", club: "Sutton FC", want: "neither", why: "member, his own club's day" },
  { text: "salı maçımız var mı?", lang: "tr", club: "Galata FC", want: "neither", why: "TR member, his own club" },
  { text: "yes count me in for the FNF game on Friday", club: "Sutton FC", want: "accept", why: "member, plainly the offer" },
  // A place he already took.
  { text: "sorry, can't make it any more", state: "taken", want: "decline", why: "taken: pulling out" },
  { text: "artık gelemiyorum kusura bakmayın", lang: "tr", state: "taken", want: "decline", why: "TR taken: pulling out" },
  { text: "where do I park?", state: "taken", want: "question", why: "taken: a question" },
  { text: "see you there", state: "taken", want: "accept", alt: ["neither"], why: "taken: confirming" },
  // Ended, swipe-replied.
  { text: "yes!", state: "ended", quoted: true, want: "accept", why: "ended: still says what he means" },
  { text: "is it still on?", state: "ended", quoted: true, want: "question", alt: ["neither"], why: "ended: asking" },
];

const HARMFUL: ReadonlySet<PoolReplyIntent> = new Set(["accept", "decline", "stop"]);

async function main() {
  let pass = 0;
  let fail = 0;
  let harmful = 0;
  console.log(`\n== Pool offer replies: ${CASES.length} cases, each once (Haiku 5.5, floor ${POOL_REPLY_MIN_CONFIDENCE}) ==\n`);
  for (const c of CASES) {
    const lang = c.lang ?? "en";
    const state = c.state ?? "open";
    const ctx: PoolReplyContext = {
      now: NOW,
      ownClub: c.club ?? null,
      quotedIndex: c.quoted ? 0 : null,
      offers: [{ state, sentAt: new Date(NOW.getTime() - 40 * 60_000), text: state === "taken" ? `${offerText(lang)}\n\n(then, after his yes)\n${placedText(lang)}` : offerText(lang) }],
    };
    const r = await readPoolReply(c.text, ctx, { model });
    const sure = r.intent !== "neither" && r.confidence >= POOL_REPLY_MIN_CONFIDENCE;
    const acted: PoolReplyIntent = sure ? r.intent : "neither";
    const ok = acted === c.want || (c.alt ?? []).includes(acted);
    const bad = !ok && sure && HARMFUL.has(r.intent);
    ok ? pass++ : fail++;
    if (bad) harmful++;
    console.log(
      `${ok ? "PASS" : bad ? "FAIL (harmful)" : "FAIL"}  ${JSON.stringify(c.text)}  ${r.intent} ${r.confidence.toFixed(2)}  ` +
        `(${c.why}; want ${c.want}${c.alt ? ` or ${c.alt.join("/")}` : ""}${c.club ? `; club ${c.club}` : ""}${state !== "open" ? `; ${state}` : ""})  ${r.reasoning}`,
    );
  }
  console.log(`\n${pass} passed, ${fail} failed (${harmful} harmful). Model calls: ${calls}. Cost: $${usd.toFixed(4)} (dev key).`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  console.log(`Model calls: ${calls}. Cost: $${usd.toFixed(4)} (dev key).`);
  process.exit(1);
});
